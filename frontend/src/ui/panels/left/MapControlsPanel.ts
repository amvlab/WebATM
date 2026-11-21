/**
 * MapControlsPanel - Manages the Map Controls panel:
 * map navigation (zoom, reset view), drawing controls (create aircraft,
 * draw shapes/routes), and the zoom/bounding-box info readout.
 */

import { BasePanel } from '../BasePanel';
import { MapDisplay, DEFAULT_CENTER, DEFAULT_ZOOM } from '../../map/MapDisplay';
import { logger } from '../../../utils/Logger';
import type { AircraftCreationManager } from '../../map/aircraft/AircraftCreationManager';
import type { ShapeDrawingManager } from '../../map/shapes/ShapeDrawingManager';
import type { RouteDrawingManager } from '../../map/routes/RouteDrawingManager';

export class MapControlsPanel extends BasePanel {
    private mapDisplay: MapDisplay | null = null;
    private aircraftCreationManager: AircraftCreationManager | null = null;
    private shapeDrawingManager: ShapeDrawingManager | null = null;
    private routeDrawingManager: RouteDrawingManager | null = null;
    private mapListenersAttached = false;

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

        this.bindClick('map-info-toggle', () => this.toggleMapInfoSection());
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

    public setMapDisplay(mapDisplay: MapDisplay): void {
        this.mapDisplay = mapDisplay;
        logger.debug('MapControlsPanel', 'MapControlsPanel connected to MapDisplay');

        // If the map is already up (App normally calls this before map init,
        // then setupMapEventListeners from the map-load callback), attach now.
        if (this.mapDisplay.isInitialized()) {
            this.setupMapEventListeners();
        }
    }

    /**
     * Attach the zoom/bbox listeners once the map is ready. Safe to call more
     * than once; the listeners are only attached once.
     */
    public setupMapEventListeners(): void {
        const map = this.mapDisplay?.getMap();
        if (!map) {
            logger.warn('MapControlsPanel', 'Map not initialized yet');
            return;
        }

        if (map.loaded()) {
            this.attachMapListeners();
        } else {
            map.once('load', () => this.attachMapListeners());
        }
    }

    private attachMapListeners(): void {
        const map = this.mapDisplay?.getMap();
        if (!map || this.mapListenersAttached) return;
        this.mapListenersAttached = true;

        map.on('zoom', () => this.updateZoomDisplay());
        map.on('moveend', () => this.updateBoundingBoxDisplay());

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

    /** Zoom in or out by a number of levels. */
    private zoomBy(delta: number): void {
        const map = this.mapDisplay?.getMap();
        if (!map) {
            logger.warn('MapControlsPanel', 'Cannot zoom: map not ready');
            return;
        }
        map.easeTo({ zoom: map.getZoom() + delta, duration: 300 });
    }

    public zoomIn(): void {
        this.zoomBy(1);
    }

    public zoomOut(): void {
        this.zoomBy(-1);
    }

    /** Reset view to the default center and zoom */
    public resetView(): void {
        const map = this.mapDisplay?.getMap();
        if (!map) {
            logger.warn('MapControlsPanel', 'Cannot reset view: map not ready');
            return;
        }
        map.flyTo({
            center: DEFAULT_CENTER,
            zoom: DEFAULT_ZOOM,
            duration: 1000,
            essential: true
        });
    }

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
