import type { MapMouseEvent } from 'maplibre-gl';
import { MapDisplay } from '../MapDisplay';
import type { NavaidSnapper } from '../navdata/NavaidSnapper';
import { logger } from '../../../utils/Logger';
import {
    DRAWING_CURSOR,
    ensureGeoJSONSource,
    ensureLayer,
    updateSourceFeatures,
    safeRemoveLayer,
    safeRemoveSource
} from '../../../utils/maplibre';
import { pointFeature, lineStringFeature } from '../../../utils/geojson';
import { roundedBearing } from '../../../utils/geo';
import { isTextEntryTarget } from '../../../utils/dom';
import { claimDrawing, releaseDrawing } from '../drawingExclusion';
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
 * Owns the map drawing state machine: click to place the aircraft,
 * move/click again to set the heading, then issue the CRE command.
 * The Create Aircraft modal itself (validation, units, autocomplete,
 * manual-mode CRE generation) lives in AircraftCreationForm, which hands
 * validated form data to this manager when map mode starts.
 */
export class AircraftCreationManager {
    private mapDisplay: MapDisplay;
    private navaidSnapper: NavaidSnapper;
    private form: AircraftCreationForm;
    private aircraftDrawingMode: boolean = false;
    private aircraftDrawingPoints: [number, number][] = [];
    private currentAircraftData: AircraftCreationData | null = null;
    private aircraftPosition: [number, number] | null = null;

    // Event handlers - stored as references for proper cleanup
    private aircraftMapClickHandler: ((e: MapMouseEvent) => void) | null = null;
    private aircraftMouseMoveHandler: ((e: MapMouseEvent) => void) | null = null;
    private aircraftSnapHoverHandler: ((e: MapMouseEvent) => void) | null = null;
    private aircraftEscapeHandler: ((e: KeyboardEvent) => void) | null = null;

    constructor(mapDisplay: MapDisplay, navaidSnapper: NavaidSnapper) {
        this.mapDisplay = mapDisplay;
        this.navaidSnapper = navaidSnapper;
        this.form = new AircraftCreationForm((data) => this.startAircraftDrawing(data));
    }

    /**
     * Show the aircraft creation modal
     */
    public showModal(): void {
        this.form.showModal();
    }

    /**
     * Whether click-to-place aircraft creation is currently active. Consumed
     * by AircraftInteractionManager to suppress empty-map-click deselection.
     */
    public isDrawing(): boolean {
        return this.aircraftDrawingMode;
    }

    /**
     * Begin the map drawing state machine with validated form data.
     * Invoked by AircraftCreationForm after the modal closes.
     */
    private startAircraftDrawing(data: AircraftCreationData): void {
        // Restart cleanly if a previous draw is still active - stale handlers
        // would double-fire each click and could never be removed again.
        if (this.aircraftDrawingMode) {
            this.stopAircraftDrawing();
        }

        this.currentAircraftData = data;
        this.aircraftDrawingMode = true;
        this.aircraftDrawingPoints = [];

        this.enableAircraftMapDrawing();

        logger.debug('AircraftCreationManager', 'Started aircraft drawing mode');
    }

    /**
     * Cancel any in-progress draw and release map/document handlers.
     * Called from App.cleanup() at page teardown.
     */
    public destroy(): void {
        if (this.aircraftDrawingMode) {
            this.stopAircraftDrawing();
        }
    }

    /**
     * Stop aircraft drawing mode
     */
    private stopAircraftDrawing(): void {
        this.aircraftDrawingMode = false;
        this.aircraftDrawingPoints = [];
        this.currentAircraftData = null;

        this.disableAircraftMapDrawing();
        this.hideDrawingBanner();

        logger.debug('AircraftCreationManager', 'Stopped aircraft drawing mode');
    }

    /**
     * Enable aircraft map drawing
     */
    private enableAircraftMapDrawing(): void {
        const map = this.mapDisplay.getMap();
        if (!map) {
            logger.warn('AircraftCreationManager', 'No radar map available for aircraft drawing');
            return;
        }

        // Cancel any in-progress shape/route draw so two tools never consume
        // the same map clicks.
        claimDrawing(this, () => this.stopAircraftDrawing());

        // A double-click during the draw is two placement clicks, not a zoom
        // request; restored in disableAircraftMapDrawing().
        map.doubleClickZoom.disable();

        // Crosshair cursor, matching the other drawing modes.
        map.getCanvas().style.cursor = DRAWING_CURSOR;

        this.aircraftMapClickHandler = (e: MapMouseEvent) => {
            this.handleAircraftMapClick(e);
        };
        map.on('click', this.aircraftMapClickHandler);

        // Highlight the navaid the cursor would snap to. This runs for both
        // phases: the first click (position) and the second click (heading
        // direction), so the user can aim the heading at a known navaid.
        this.aircraftSnapHoverHandler = (e: MapMouseEvent) => {
            if (this.aircraftDrawingPoints.length < 2) {
                this.navaidSnapper.highlight(e);
            }
        };
        map.on('mousemove', this.aircraftSnapHoverHandler);

        // Escape cancels the draw at any phase, matching the other drawing
        // modes.
        this.aircraftEscapeHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !isTextEntryTarget(e.target)) {
                this.stopAircraftDrawing();
            }
        };
        document.addEventListener('keydown', this.aircraftEscapeHandler);

        this.showDrawingBanner();
        this.updateDrawingBanner('Click on map to set aircraft position');
    }

    /**
     * Disable aircraft map drawing
     */
    private disableAircraftMapDrawing(): void {
        // The map can already be gone at teardown; the document-level Escape
        // listener and the drawing claim must be released regardless.
        const map = this.mapDisplay.getMap();
        if (map) {
            map.doubleClickZoom.enable();
            // Restore MapLibre's default cursor when leaving drawing mode.
            map.getCanvas().style.cursor = '';
            if (this.aircraftMapClickHandler) map.off('click', this.aircraftMapClickHandler);
            if (this.aircraftMouseMoveHandler) map.off('mousemove', this.aircraftMouseMoveHandler);
            if (this.aircraftSnapHoverHandler) map.off('mousemove', this.aircraftSnapHoverHandler);
        }
        this.aircraftMapClickHandler = null;
        this.aircraftMouseMoveHandler = null;
        this.aircraftSnapHoverHandler = null;
        this.navaidSnapper.clearHighlight();

        if (this.aircraftEscapeHandler) {
            document.removeEventListener('keydown', this.aircraftEscapeHandler);
            this.aircraftEscapeHandler = null;
        }

        this.aircraftPosition = null;
        this.clearTemporaryAircraftDrawing();
        releaseDrawing(this);
    }

    /**
     * Handle aircraft map click
     */
    private handleAircraftMapClick(e: MapMouseEvent): void {
        if (!this.aircraftDrawingMode) return;

        // The second click of a double-click is a repeat of the first, not a
        // deliberate placement - without this, double-clicking the position
        // would instantly create the aircraft with a meaningless heading.
        if (e.originalEvent.detail > 1) return;

        // Snap both clicks to a nearby navaid when enabled: the first click sets
        // the spawn position, the second sets the heading/direction (aim at a
        // known navaid for a precise heading).
        let point: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        const snapped = this.navaidSnapper.snap(e);
        if (snapped) point = [snapped.lng, snapped.lat];

        // A heading click on the exact spawn position (e.g. both clicks
        // snapped to the same navaid) has no direction; drop it and keep
        // waiting, mirroring the circle tool's zero-radius guard.
        const [position] = this.aircraftDrawingPoints;
        if (position && position[0] === point[0] && position[1] === point[1]) {
            this.updateDrawingBanner('Click a point away from the aircraft to set its heading');
            return;
        }

        this.aircraftDrawingPoints.push(point);

        if (this.aircraftDrawingPoints.length === 1) {
            // First click - set position. Keep the snap highlight active so the
            // heading click can also snap to a navaid.
            this.updateDrawingBanner('Move mouse to see heading guide, then click to confirm direction');
            this.visualizeAircraftPosition(point);
        } else if (this.aircraftDrawingPoints.length === 2) {
            this.completeAircraftDrawing();
        }
    }

    /**
     * Visualize aircraft position
     */
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

        // Store position for the heading guide line.
        this.aircraftPosition = position;

        // Follow the cursor with a guide line. Snap the endpoint to a nearby
        // navaid so the previewed heading matches what the second click will
        // commit.
        this.aircraftMouseMoveHandler = (e: MapMouseEvent) => {
            const snapped = this.navaidSnapper.snap(e);
            this.updateHeadingGuideLine(snapped ?? e.lngLat);
        };
        map.on('mousemove', this.aircraftMouseMoveHandler);
    }

    /**
     * Update heading guide line
     */
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
        this.updateDrawingBanner(`Heading: ${heading}° - Click to confirm direction`);
    }

    /**
     * Complete aircraft drawing
     */
    private completeAircraftDrawing(): void {
        if (this.aircraftDrawingPoints.length < 2 || !this.currentAircraftData) {
            logger.warn('AircraftCreationManager', 'Insufficient data for aircraft creation');
            return;
        }

        const [position, headingPoint] = this.aircraftDrawingPoints;
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

        this.stopAircraftDrawing();
    }

    /**
     * Clear temporary aircraft drawing
     */
    private clearTemporaryAircraftDrawing(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        safeRemoveLayer(map, POSITION_LAYER);
        safeRemoveLayer(map, GUIDE_LAYER);
        safeRemoveSource(map, POSITION_SOURCE);
        safeRemoveSource(map, GUIDE_SOURCE);
    }

    /**
     * Show drawing banner
     */
    private showDrawingBanner(): void {
        const banner = document.getElementById('drawing-banner');
        if (banner) banner.style.display = 'flex';
    }

    /**
     * Hide drawing banner
     */
    private hideDrawingBanner(): void {
        const banner = document.getElementById('drawing-banner');
        if (banner) banner.style.display = 'none';
    }

    /**
     * Update drawing banner message
     */
    private updateDrawingBanner(message: string): void {
        const bannerText = document.getElementById('drawing-banner-text');
        if (bannerText) {
            bannerText.textContent = message;
        }
    }
}
