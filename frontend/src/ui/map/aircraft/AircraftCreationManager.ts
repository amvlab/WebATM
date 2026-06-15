import type { GeoJSONSource, MapMouseEvent } from 'maplibre-gl';
import { MapDisplay } from '../MapDisplay';
import type { NavaidSnapper } from '../navdata/NavaidSnapper';
import { logger } from '../../../utils/Logger';
import { DRAWING_CURSOR } from '../../../utils/maplibre';
import {
    AircraftCreationForm,
    AircraftCreationData,
    convertAltitudeToFeet,
    convertSpeedToKnots
} from './AircraftCreationForm';

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
     * Begin the map drawing state machine with validated form data.
     * Invoked by AircraftCreationForm after the modal closes.
     */
    private startAircraftDrawing(data: AircraftCreationData): void {
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
            this.clearTemporaryAircraftDrawing();
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

        // Disable map drawing
        this.disableAircraftMapDrawing();

        // Hide drawing banner
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

        // Match the crosshair cursor used by the console map picker and the
        // shape/route drawing modes so every drawing mode looks the same.
        map.getCanvas().style.cursor = DRAWING_CURSOR;

        // Add click handler for aircraft positioning
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

        // Show drawing banner
        logger.debug('AircraftCreationManager', 'About to show drawing mode and banner');
        this.showDrawingBanner();
        this.updateDrawingBanner('Click on map to set aircraft position');
        logger.debug('AircraftCreationManager', 'Drawing mode and banner should now be visible');

        logger.debug('AircraftCreationManager', 'Enabled aircraft map drawing');
    }

    /**
     * Disable aircraft map drawing
     */
    private disableAircraftMapDrawing(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        // Restore MapLibre's default cursor when leaving drawing mode.
        map.getCanvas().style.cursor = '';

        if (this.aircraftMapClickHandler) {
            map.off('click', this.aircraftMapClickHandler);
            this.aircraftMapClickHandler = null;
        }

        if (this.aircraftMouseMoveHandler) {
            map.off('mousemove', this.aircraftMouseMoveHandler);
            this.aircraftMouseMoveHandler = null;
        }

        if (this.aircraftSnapHoverHandler) {
            map.off('mousemove', this.aircraftSnapHoverHandler);
            this.aircraftSnapHoverHandler = null;
        }
        this.navaidSnapper.clearHighlight();

        // Remove escape key handler
        if (this.aircraftEscapeHandler) {
            document.removeEventListener('keydown', this.aircraftEscapeHandler);
            this.aircraftEscapeHandler = null;
        }

        // Clear stored position
        this.aircraftPosition = null;

        // Clear temporary aircraft visualization
        this.clearTemporaryAircraftDrawing();

        logger.debug('AircraftCreationManager', 'Disabled aircraft map drawing');
    }

    /**
     * Handle aircraft map click
     */
    private handleAircraftMapClick(e: MapMouseEvent): void {
        if (!this.aircraftDrawingMode) {
            logger.debug('AircraftCreationManager', 'Aircraft drawing mode not active, ignoring click');
            return;
        }

        // Snap both clicks to a nearby navaid when enabled: the first click sets
        // the spawn position, the second sets the heading/direction (aim at a
        // known navaid for a precise heading).
        let point: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        const snapped = this.navaidSnapper.snap(e);
        if (snapped) point = [snapped.lng, snapped.lat];
        this.aircraftDrawingPoints.push(point);

        logger.debug('AircraftCreationManager', `Aircraft click ${this.aircraftDrawingPoints.length} at [${point[1].toFixed(4)}, ${point[0].toFixed(4)}]`);

        if (this.aircraftDrawingPoints.length === 1) {
            // First click - set position. Keep the snap highlight active so the
            // heading click can also snap to a navaid.
            this.updateDrawingBanner('Move mouse to see heading guide, then click to confirm direction');
            this.visualizeAircraftPosition(point);
        } else if (this.aircraftDrawingPoints.length === 2) {
            // Second click - set heading and create aircraft
            logger.debug('AircraftCreationManager', 'Second click detected, completing aircraft drawing');
            this.completeAircraftDrawing();
        }
    }

    /**
     * Visualize aircraft position
     */
    private visualizeAircraftPosition(position: [number, number]): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        // Add simple circle visualization (like line drawing)
        const aircraftSource = {
            'type': 'geojson' as const,
            'data': {
                'type': 'FeatureCollection' as const,
                'features': [{
                    'type': 'Feature' as const,
                    'geometry': {
                        'type': 'Point' as const,
                        'coordinates': position
                    },
                    'properties': {}
                }]
            }
        };

        // Clean up existing visualization
        if (map.getSource('temp-aircraft-position')) {
            map.removeLayer('temp-aircraft-position-layer');
            map.removeSource('temp-aircraft-position');
        }

        // Add simple circle layer (like line drawing)
        map.addSource('temp-aircraft-position', aircraftSource);
        map.addLayer({
            'id': 'temp-aircraft-position-layer',
            'type': 'circle',
            'source': 'temp-aircraft-position',
            'paint': {
                'circle-radius': 8,
                'circle-color': '#ff6600',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#ffffff'
            }
        });

        // Store position for guide line
        this.aircraftPosition = position;

        // Add mouse move handler for guide line. Snap the guide endpoint to a
        // nearby navaid so the previewed heading matches what the second click
        // will commit.
        this.aircraftMouseMoveHandler = (e: MapMouseEvent) => {
            const snapped = this.navaidSnapper.snap(e);
            const guidePos = snapped ? { lng: snapped.lng, lat: snapped.lat } : e.lngLat;
            this.updateHeadingGuideLine(guidePos);
        };

        map.on('mousemove', this.aircraftMouseMoveHandler);

        // Add escape key handler to exit drawing mode
        this.aircraftEscapeHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                logger.debug('AircraftCreationManager', 'Escape pressed, exiting aircraft drawing mode');
                this.stopAircraftDrawing();
            }
        };

        document.addEventListener('keydown', this.aircraftEscapeHandler);
    }

    /**
     * Update heading guide line
     */
    private updateHeadingGuideLine(mousePosition: { lng: number, lat: number }): void {
        const map = this.mapDisplay.getMap();
        if (!map || !this.aircraftPosition) return;

        // Create guide line from aircraft position to mouse cursor
        const guideLineSource = {
            'type': 'geojson' as const,
            'data': {
                'type': 'FeatureCollection' as const,
                'features': [{
                    'type': 'Feature' as const,
                    'geometry': {
                        'type': 'LineString' as const,
                        'coordinates': [this.aircraftPosition, [mousePosition.lng, mousePosition.lat]]
                    },
                    'properties': {}
                }]
            }
        };

        // Update or create guide line
        const existingSource = map.getSource<GeoJSONSource>('temp-aircraft-guideline');
        if (existingSource) {
            existingSource.setData(guideLineSource.data);
        } else {
            map.addSource('temp-aircraft-guideline', guideLineSource);
            map.addLayer({
                'id': 'temp-aircraft-guideline-layer',
                'type': 'line',
                'source': 'temp-aircraft-guideline',
                'layout': {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                'paint': {
                    'line-color': '#ff6600',
                    'line-width': 2,
                    'line-dasharray': [3, 3],
                    'line-opacity': 0.8
                }
            });
        }

        // Calculate aviation heading for display (0° = North, 90° = East)
        const lat1 = this.aircraftPosition[1] * Math.PI / 180;
        const lat2 = mousePosition.lat * Math.PI / 180;
        const deltaLng = (mousePosition.lng - this.aircraftPosition[0]) * Math.PI / 180;

        const y = Math.sin(deltaLng) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

        const mathAngle = Math.atan2(y, x) * 180 / Math.PI;
        const heading = Math.round((mathAngle + 360) % 360); // Round to nearest degree

        // Update drawing banner with current heading
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

        const position = this.aircraftDrawingPoints[0];
        const headingPoint = this.aircraftDrawingPoints[1];

        // Calculate aviation heading (0° = North, 90° = East, 180° = South, 270° = West)
        const lat1 = position[1] * Math.PI / 180;
        const lat2 = headingPoint[1] * Math.PI / 180;
        const deltaLng = (headingPoint[0] - position[0]) * Math.PI / 180;

        const y = Math.sin(deltaLng) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

        // Math.atan2 gives mathematical angle: 0° = East, 90° = North, -90° = South, 180°/-180° = West
        // Convert to aviation heading: 0° = North, 90° = East, 180° = South, 270° = West
        const mathAngle = Math.atan2(y, x) * 180 / Math.PI;

        // Geographic calculation already gives correct aviation angles:
        // North=0°, East=90°, South=180°, West=-90°
        // Just need to normalize negative West angle (-90° → 270°)
        let heading = (mathAngle + 360) % 360;
        heading = Math.round(heading);

        logger.debug('AircraftCreationManager', `Position: [${position[1].toFixed(4)}, ${position[0].toFixed(4)}] → [${headingPoint[1].toFixed(4)}, ${headingPoint[0].toFixed(4)}]`);
        logger.debug('AircraftCreationManager', `Heading calculation: mathAngle=${mathAngle.toFixed(1)}°, aviation=${heading}°`);

        // Convert units to BlueSky format (always feet and knots)
        const altFeet = convertAltitudeToFeet(this.currentAircraftData.altDisplay, this.currentAircraftData.altUnit);
        const speedKnots = convertSpeedToKnots(this.currentAircraftData.spdDisplay, this.currentAircraftData.spdUnit);

        logger.debug('AircraftCreationManager', `Unit conversion: ${this.currentAircraftData.altDisplay}${this.currentAircraftData.altUnit} → ${altFeet}ft, ${this.currentAircraftData.spdDisplay}${this.currentAircraftData.spdUnit} → ${speedKnots}kts`);

        // Build and send CRE command
        const command = `CRE ${this.currentAircraftData.id},${this.currentAircraftData.actype},${position[1]},${position[0]},${heading},${altFeet},${speedKnots}`;

        logger.info('AircraftCreationManager', `Creating aircraft with command: ${command}`);
        logger.debug('AircraftCreationManager', `Position: [${position[1]}, ${position[0]}], Heading: ${heading}°`);

        // Send command to BlueSky
        if (window.app) {
            window.app.sendCommand(command);
            logger.debug('AircraftCreationManager', 'Command sent to BlueSky');

            // Display the command in the console
            logger.debug('AircraftCreationManager', '(map mode) Getting console instance from app');
            const consoleInstance = window.app.getConsole();
            logger.debug('AircraftCreationManager', '(map mode) Console instance:', consoleInstance);

            if (consoleInstance) {
                logger.debug('AircraftCreationManager', '(map mode) Calling displaySentCommand with:', command);
                consoleInstance.displaySentCommand(command);
            } else {
                logger.warn('AircraftCreationManager', '(map mode) Console instance is null');
            }
        } else {
            logger.error('AircraftCreationManager', '✈️ Cannot send command: app not available');
        }

        // Clean up drawing state
        this.stopAircraftDrawing();
    }

    /**
     * Clear temporary aircraft drawing
     */
    private clearTemporaryAircraftDrawing(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        // Remove temporary layers and sources
        const layersToRemove = ['temp-aircraft-position-layer', 'temp-aircraft-guideline-layer'];
        const sourcesToRemove = ['temp-aircraft-position', 'temp-aircraft-guideline'];

        layersToRemove.forEach(layerId => {
            if (map.getLayer(layerId)) {
                map.removeLayer(layerId);
            }
        });

        sourcesToRemove.forEach(sourceId => {
            if (map.getSource(sourceId)) {
                map.removeSource(sourceId);
            }
        });

        logger.debug('AircraftCreationManager', 'Cleared temporary aircraft drawing visualization');
    }

    /**
     * Show drawing banner
     */
    private showDrawingBanner(): void {
        const banner = document.getElementById('drawing-banner');

        if (banner) banner.style.display = 'flex';

        logger.debug('AircraftCreationManager', 'Showing drawing mode banner');
    }

    /**
     * Hide drawing banner
     */
    private hideDrawingBanner(): void {
        const banner = document.getElementById('drawing-banner');

        if (banner) banner.style.display = 'none';

        logger.debug('AircraftCreationManager', 'Hiding drawing mode banner');
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
