/**
 * MapControlsPanel - Manages the Map Controls panel
 *
 * This panel handles:
 * - Map navigation controls (zoom, pan, reset view)
 * - Drawing controls (create aircraft, draw shapes)
 * - Bounding box display
 */

import { BasePanel } from '../BasePanel';
import { MapDisplay } from '../../map/MapDisplay';
import { logger } from '../../../utils/Logger';
import type { AircraftCreationManager } from '../../map/aircraft/AircraftCreationManager';
import type { ShapeDrawingManager } from '../../map/shapes/ShapeDrawingManager';
import type { RouteDrawingManager } from '../../map/routes/RouteDrawingManager';

export class MapControlsPanel extends BasePanel {
    private mapDisplay: MapDisplay | null = null;
    private aircraftCreationManager: AircraftCreationManager | null = null;
    private shapeDrawingManager: ShapeDrawingManager | null = null;
    private routeDrawingManager: RouteDrawingManager | null = null;
    private readonly DEFAULT_CENTER: [number, number] = [4.9, 52.3]; // Amsterdam
    private readonly DEFAULT_ZOOM = 8;

    constructor() {
        super('.nav-panel', 'map-view-content');
    }

    protected onInit(): void {
        logger.debug('MapControlsPanel', 'MapControlsPanel initialized');

        this.bindClick('create-aircraft-btn', () =>
            this.withManager(this.aircraftCreationManager, 'AircraftCreationManager', m => m.showModal()));
        this.bindClick('draw-shape-btn', () =>
            this.withManager(this.shapeDrawingManager, 'ShapeDrawingManager', m => m.toggleDrawing()));
        this.bindClick('draw-route-btn', () =>
            this.withManager(this.routeDrawingManager, 'RouteDrawingManager', m => m.toggleDrawing()));

        this.setupMapInfoHandlers();
    }

    /**
     * Run a drawing-button action against its manager, or tell the user the
     * map is still loading when the manager hasn't been wired up yet.
     */
    private withManager<T>(manager: T | null, name: string, action: (manager: T) => void): void {
        if (manager) {
            action(manager);
        } else {
            logger.warn('MapControlsPanel', `${name} not set - map may still be loading`);
            alert('Map is still loading. Please wait a moment and try again.');
        }
    }

    /**
     * Set the MapDisplay instance for this panel
     */
    public setMapDisplay(mapDisplay: MapDisplay): void {
        this.mapDisplay = mapDisplay;
        logger.debug('MapControlsPanel', 'MapControlsPanel connected to MapDisplay');

        // Check if map is already initialized, if so, set up listeners immediately
        if (this.mapDisplay.isInitialized()) {
            this.setupMapEventListeners();
        }
        // Otherwise, listeners will be set up when map initialization is complete
        // (App.ts should call setupMapEventListeners after map is initialized)
    }

    /**
     * Set up map info handlers (zoom, bbox)
     */
    private setupMapInfoHandlers(): void {
        this.bindClick('map-info-toggle', () => this.toggleMapInfoSection());

        // Initial update of zoom and bounding box will happen when map is set
    }

    /**
     * Set up event listeners on the MapLibre GL map
     * This should be called after the map is initialized
     */
    public setupMapEventListeners(): void {
        if (!this.mapDisplay) return;

        const map = this.mapDisplay.getMap();
        if (!map) {
            logger.warn('MapControlsPanel', 'Map not initialized yet');
            return;
        }

        // Check if map is already loaded
        if (map.loaded()) {
            // Map is ready, set up listeners immediately
            this.attachMapListeners();
        } else {
            // Wait for map to load before attaching listeners
            map.once('load', () => {
                this.attachMapListeners();
            });
        }
    }

    /**
     * Attach event listeners to the map
     */
    private attachMapListeners(): void {
        if (!this.mapDisplay) return;

        const map = this.mapDisplay.getMap();
        if (!map) return;

        // Update zoom level on zoom events
        map.on('zoom', () => {
            this.updateZoomDisplay();
        });

        // Update bounding box on moveend events
        map.on('moveend', () => {
            this.updateBoundingBoxDisplay();
        });

        // Initial update
        this.updateZoomDisplay();
        this.updateBoundingBoxDisplay();

        logger.debug('MapControlsPanel', 'Map event listeners attached for zoom and bbox updates');
    }

    private updateZoomDisplay(): void {
        const map = this.mapDisplay?.getMap();
        if (!map) return;

        this.setText('current-zoom', map.getZoom().toFixed(1));
    }

    private updateBoundingBoxDisplay(): void {
        const map = this.mapDisplay?.getMap();
        if (!map) return;

        const bounds = map.getBounds();
        this.setText('bbox-north', bounds.getNorth().toFixed(2));
        this.setText('bbox-south', bounds.getSouth().toFixed(2));
        this.setText('bbox-east', bounds.getEast().toFixed(2));
        this.setText('bbox-west', bounds.getWest().toFixed(2));
    }

    public setAircraftCreationManager(manager: AircraftCreationManager): void {
        this.aircraftCreationManager = manager;
    }

    public setShapeDrawingManager(manager: ShapeDrawingManager): void {
        this.shapeDrawingManager = manager;
    }

    public setRouteDrawingManager(manager: RouteDrawingManager): void {
        this.routeDrawingManager = manager;
    }

    /** Zoom in by one level */
    public zoomIn(): void {
        const map = this.mapDisplay?.getMap();
        if (!map) {
            logger.warn('MapControlsPanel', 'Cannot zoom in: map not ready');
            return;
        }
        map.easeTo({ zoom: map.getZoom() + 1, duration: 300 });
    }

    /** Zoom out by one level */
    public zoomOut(): void {
        const map = this.mapDisplay?.getMap();
        if (!map) {
            logger.warn('MapControlsPanel', 'Cannot zoom out: map not ready');
            return;
        }
        map.easeTo({ zoom: map.getZoom() - 1, duration: 300 });
    }

    /** Reset view to the default center and zoom */
    public resetView(): void {
        const map = this.mapDisplay?.getMap();
        if (!map) {
            logger.warn('MapControlsPanel', 'Cannot reset view: map not ready');
            return;
        }
        map.flyTo({
            center: this.DEFAULT_CENTER,
            zoom: this.DEFAULT_ZOOM,
            duration: 1000,
            essential: true
        });
    }

    /**
     * Toggle the map info collapsible section
     */
    private toggleMapInfoSection(): void {
        const section = document.getElementById('map-info-controls');
        const toggleBtn = document.getElementById('map-info-toggle');

        if (!section || !toggleBtn) return;

        const open = !section.classList.contains('open');
        section.classList.toggle('open', open);
        toggleBtn.classList.toggle('open', open);

        if (open) {
            // Once the expand animation has finished, make sure the section
            // is visible within the scrollable panel
            window.setTimeout(() => {
                section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }, 240);
        }

        logger.debug('MapControlsPanel', `Map Info section ${open ? 'expanded' : 'collapsed'}`);
    }

    public update(_data?: unknown): void {
        // Update logic if needed
    }
}
