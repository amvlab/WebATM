import { MapDisplay } from '../MapDisplay';
import type { NavaidSnapper } from '../navdata/NavaidSnapper';
import { BaseDrawingManager, DrawingPoint } from '../BaseDrawingManager';
import { logger } from '../../../utils/Logger';
import {
    ensureGeoJSONSource,
    ensureLayer,
    updateSourceFeatures,
    safeRemoveLayer,
    safeRemoveSource
} from '../../../utils/maplibre';
import { pointFeature, lineStringFeature } from '../../../utils/geojson';
import { roundedBearing } from '../../../utils/geo';
import {
    AircraftCreationForm,
    AircraftCreationData,
    convertAltitudeToFeet,
    convertSpeedToKnots
} from './AircraftCreationForm';

const POSITION_SOURCE = 'temp-aircraft-position';
const POSITION_LAYER = 'temp-aircraft-position-layer';
const GUIDE_SOURCE = 'temp-aircraft-guideline';
const GUIDE_LAYER = 'temp-aircraft-guideline-layer';

/**
 * AircraftCreationManager - Manages map-based aircraft creation
 *
 * Owns the map drawing state machine on top of BaseDrawingManager: click to
 * place the aircraft, move/click again to set the heading, then issue the
 * CRE command. The Create Aircraft modal itself (validation, units,
 * autocomplete, manual-mode CRE generation) lives in AircraftCreationForm,
 * which hands validated form data to this manager when map mode starts.
 */
export class AircraftCreationManager extends BaseDrawingManager {
    private form: AircraftCreationForm;
    private drawingPoints: [number, number][] = [];
    private currentAircraftData: AircraftCreationData | null = null;
    private aircraftPosition: [number, number] | null = null;

    constructor(mapDisplay: MapDisplay, navaidSnapper: NavaidSnapper) {
        super(mapDisplay, navaidSnapper);
        this.form = new AircraftCreationForm((data) => this.startAircraftDrawing(data));
    }

    public showModal(): void {
        this.form.showModal();
    }

    public toggleDrawing(): void {
        if (this.drawingMode) {
            this.cancelDrawing();
        } else {
            this.showModal();
        }
    }

    /**
     * Begin the map drawing state machine with validated form data.
     * Invoked by AircraftCreationForm after the modal closes.
     */
    private startAircraftDrawing(data: AircraftCreationData): void {
        // Restart cleanly if a previous draw is still active - stale handlers
        // would double-fire each click and could never be removed again.
        if (this.drawingMode) {
            this.cancelDrawing();
        }

        this.currentAircraftData = data;
        this.drawingMode = true;
        this.drawingPoints = [];

        this.enableMapDrawing();

        logger.debug('AircraftCreationManager', 'Started aircraft drawing mode');
    }

    protected cancelDrawing(): void {
        this.drawingMode = false;
        this.drawingPoints = [];
        this.currentAircraftData = null;

        this.disableMapDrawing();

        logger.debug('AircraftCreationManager', 'Stopped aircraft drawing mode');
    }

    protected onDrawingEnabled(): void {
        this.showDrawingBanner('Click on map to set aircraft position');
    }

    protected onDrawingDisabled(): void {
        this.aircraftPosition = null;
        this.clearTemporaryAircraftDrawing();
        this.hideDrawingBanner();
    }

    protected onPointAdded(point: DrawingPoint): void {
        const p: [number, number] = [point.lng, point.lat];

        // A heading click on the exact spawn position (e.g. both clicks
        // snapped to the same navaid) has no direction; drop it and keep
        // waiting, mirroring the circle tool's zero-radius guard.
        const [position] = this.drawingPoints;
        if (position && position[0] === p[0] && position[1] === p[1]) {
            this.showDrawingBanner('Click a point away from the aircraft to set its heading');
            return;
        }

        this.drawingPoints.push(p);

        if (this.drawingPoints.length === 1) {
            // First click - set position; the second click sets the heading.
            this.showDrawingBanner('Move mouse to see heading guide, then click to confirm direction');
            this.visualizeAircraftPosition(p);
        } else if (this.drawingPoints.length === 2) {
            this.finishDrawing();
        }
    }

    protected onCursorMove(point: DrawingPoint): void {
        // Phase 1 (before the position click) only shows the snap highlight,
        // which the base class already handles.
        if (!this.aircraftPosition) return;
        this.updateHeadingGuideLine(point);
    }

    private visualizeAircraftPosition(position: [number, number]): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        ensureGeoJSONSource(map, POSITION_SOURCE);
        ensureLayer(map, {
            id: POSITION_LAYER,
            type: 'circle',
            source: POSITION_SOURCE,
            paint: {
                'circle-radius': 8,
                'circle-color': '#ff6600',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#ffffff'
            }
        });
        updateSourceFeatures(map, POSITION_SOURCE, [pointFeature(position)]);

        // Anchor for the heading guide line drawn on cursor moves.
        this.aircraftPosition = position;
    }

    private updateHeadingGuideLine(mousePosition: { lng: number, lat: number }): void {
        const map = this.mapDisplay.getMap();
        if (!map || !this.aircraftPosition) return;

        ensureGeoJSONSource(map, GUIDE_SOURCE);
        ensureLayer(map, {
            id: GUIDE_LAYER,
            type: 'line',
            source: GUIDE_SOURCE,
            layout: {
                'line-join': 'round',
                'line-cap': 'round'
            },
            paint: {
                'line-color': '#ff6600',
                'line-width': 2,
                'line-dasharray': [3, 3],
                'line-opacity': 0.8
            }
        });
        updateSourceFeatures(map, GUIDE_SOURCE, [
            lineStringFeature([this.aircraftPosition, [mousePosition.lng, mousePosition.lat]])
        ]);

        const heading = roundedBearing(
            this.aircraftPosition[1],
            this.aircraftPosition[0],
            mousePosition.lat,
            mousePosition.lng
        );
        this.showDrawingBanner(`Heading: ${heading}° - Click to confirm direction`);
    }

    /** Both points placed: build and send the CRE command. */
    protected finishDrawing(): void {
        if (this.drawingPoints.length < 2 || !this.currentAircraftData) {
            // Right-click before the heading click - nothing to finish yet.
            return;
        }

        const [position, headingPoint] = this.drawingPoints;
        const heading = roundedBearing(
            position[1],
            position[0],
            headingPoint[1],
            headingPoint[0]
        );

        // Convert units to BlueSky format (always feet and knots)
        const altFeet = convertAltitudeToFeet(this.currentAircraftData.altDisplay, this.currentAircraftData.altUnit);
        const speedKnots = convertSpeedToKnots(this.currentAircraftData.spdDisplay, this.currentAircraftData.spdUnit);

        const command = `CRE ${this.currentAircraftData.id},${this.currentAircraftData.actype},${position[1]},${position[0]},${heading},${altFeet},${speedKnots}`;
        logger.info('AircraftCreationManager', `Creating aircraft with command: ${command}`);

        if (window.app) {
            window.app.sendCommand(command);
            window.app.getConsole()?.displaySentCommand(command);
        } else {
            logger.error('AircraftCreationManager', 'Cannot send command: app not available');
        }

        this.cancelDrawing();
    }

    private clearTemporaryAircraftDrawing(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        safeRemoveLayer(map, POSITION_LAYER);
        safeRemoveLayer(map, GUIDE_LAYER);
        safeRemoveSource(map, POSITION_SOURCE);
        safeRemoveSource(map, GUIDE_SOURCE);
    }
}
