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

export class MapControlsPanel extends BasePanel {
    private mapDisplay: MapDisplay | null = null;
    private aircraftCreationManager: any = null; // Will be typed when manager is created
    private shapeDrawingManager: any = null; // Will be typed when manager is created
    private readonly DEFAULT_CENTER: [number, number] = [4.9, 52.3]; // Amsterdam
    private readonly DEFAULT_ZOOM = 8;

    constructor() {
        super('.nav-panel', 'map-view-content');
    }

    protected onInit(): void {
        logger.debug('MapControlsPanel', 'MapControlsPanel initialized');

        // Set up button event handlers
        this.setupButtonHandlers();

        // Set up map info update handlers
        this.setupMapInfoHandlers();
    }

    /**
     * Set up button event handlers
     */
    private setupButtonHandlers(): void {
        // Create Aircraft button
        const createAircraftBtn = document.getElementById('create-aircraft-btn');
        if (createAircraftBtn) {
            createAircraftBtn.addEventListener('click', () => {
                this.onCreateAircraftClick();
            });
            logger.debug('MapControlsPanel', 'Create Aircraft button handler attached');
        } else {
            logger.warn('MapControlsPanel', '✗ Create Aircraft button not found');
        }

        // Draw Shape button
        const drawShapeBtn = document.getElementById('draw-shape-btn');
        if (drawShapeBtn) {
            drawShapeBtn.addEventListener('click', () => {
                this.onDrawShapeClick();
            });
            logger.debug('MapControlsPanel', 'Draw Shape button handler attached');
        } else {
            logger.warn('MapControlsPanel', '✗ Draw Shape button not found');
        }
    }

    /**
     * Handle Create Aircraft button click
     */
    private onCreateAircraftClick(): void {
        logger.debug('MapControlsPanel', 'Create Aircraft button clicked');
        // Will be connected to AircraftCreationManager
        if (this.aircraftCreationManager) {
            this.aircraftCreationManager.showModal();
        } else {
            logger.warn('MapControlsPanel', 'AircraftCreationManager not set - map may still be loading');
            // Optionally show a user-friendly message
            alert('Map is still loading. Please wait a moment and try again.');
        }
    }

    /**
     * Handle Draw Shape button click
     */
    private onDrawShapeClick(): void {
        logger.debug('MapControlsPanel', 'Draw Shape button clicked');
        // Will be connected to ShapeDrawingManager
        if (this.shapeDrawingManager) {
            this.shapeDrawingManager.toggleDrawing();
        } else {
            logger.warn('MapControlsPanel', 'ShapeDrawingManager not set - map may still be loading');
            // Optionally show a user-friendly message
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
        // Set up map info toggle
        const mapInfoToggle = document.getElementById('map-info-toggle');
        if (mapInfoToggle) {
            mapInfoToggle.addEventListener('click', () => {
                this.toggleMapInfoSection();
            });
            logger.debug('MapControlsPanel', 'Map Info toggle handler attached');
        } else {
            logger.warn('MapControlsPanel', '✗ Map Info toggle button not found');
        }
        
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

    /**
     * Update the zoom level display
     */
    private updateZoomDisplay(): void {
        if (!this.mapDisplay) return;

        const map = this.mapDisplay.getMap();
        if (!map) return;

        const zoom = map.getZoom();
        const zoomElement = document.getElementById('current-zoom');

        if (zoomElement) {
            zoomElement.textContent = zoom.toFixed(1);
        }
    }

    /**
     * Update the bounding box display
     */
    private updateBoundingBoxDisplay(): void {
        if (!this.mapDisplay) return;

        const map = this.mapDisplay.getMap();
        if (!map) return;

        const bounds = map.getBounds();

        const north = bounds.getNorth();
        const south = bounds.getSouth();
        const east = bounds.getEast();
        const west = bounds.getWest();

        // Update the display elements
        const northElement = document.getElementById('bbox-north');
        const southElement = document.getElementById('bbox-south');
        const eastElement = document.getElementById('bbox-east');
        const westElement = document.getElementById('bbox-west');

        if (northElement) northElement.textContent = north.toFixed(2);
        if (southElement) southElement.textContent = south.toFixed(2);
        if (eastElement) eastElement.textContent = east.toFixed(2);
        if (westElement) westElement.textContent = west.toFixed(2);
    }

    /**
     * Set the AircraftCreationManager instance
     */
    public setAircraftCreationManager(manager: any): void {
        this.aircraftCreationManager = manager;
        logger.debug('MapControlsPanel', 'MapControlsPanel connected to AircraftCreationManager');
    }

    /**
     * Set the ShapeDrawingManager instance
     */
    public setShapeDrawingManager(manager: any): void {
        this.shapeDrawingManager = manager;
        logger.debug('MapControlsPanel', 'MapControlsPanel connected to ShapeDrawingManager');
    }

    /**
     * Zoom in by one level
     */
    public zoomIn(): void {
        if (!this.mapDisplay) {
            logger.warn('MapControlsPanel', 'Cannot zoom in: MapDisplay not set');
            return;
        }

        const map = this.mapDisplay.getMap();
        if (!map) {
            logger.warn('MapControlsPanel', 'Cannot zoom in: Map not initialized');
            return;
        }

        const currentZoom = map.getZoom();
        map.easeTo({ zoom: currentZoom + 1, duration: 300 });
        logger.debug('MapControlsPanel', 'Zooming in to level:', currentZoom + 1);
    }

    /**
     * Zoom out by one level
     */
    public zoomOut(): void {
        if (!this.mapDisplay) {
            logger.warn('MapControlsPanel', 'Cannot zoom out: MapDisplay not set');
            return;
        }

        const map = this.mapDisplay.getMap();
        if (!map) {
            logger.warn('MapControlsPanel', 'Cannot zoom out: Map not initialized');
            return;
        }

        const currentZoom = map.getZoom();
        map.easeTo({ zoom: currentZoom - 1, duration: 300 });
        logger.debug('MapControlsPanel', 'Zooming out to level:', currentZoom - 1);
    }

    /**
     * Reset view to default center and zoom
     */
    public resetView(): void {
        if (!this.mapDisplay) {
            logger.warn('MapControlsPanel', 'Cannot reset view: MapDisplay not set');
            return;
        }

        const map = this.mapDisplay.getMap();
        if (!map) {
            logger.warn('MapControlsPanel', 'Cannot reset view: Map not initialized');
            return;
        }

        map.flyTo({
            center: this.DEFAULT_CENTER,
            zoom: this.DEFAULT_ZOOM,
            duration: 1000,
            essential: true
        });
        logger.debug('MapControlsPanel', 'Resetting view to default center and zoom');
    }

    /**
     * Toggle the map info collapsible section
     */
    private toggleMapInfoSection(): void {
        const section = document.getElementById('map-info-controls');
        const toggleBtn = document.getElementById('map-info-toggle');
        
        if (!section || !toggleBtn) return;

        const isVisible = section.style.display === 'block';
        const newVisibility = !isVisible;

        // Update display
        section.style.display = newVisibility ? 'block' : 'none';
        
        // Update button text
        toggleBtn.textContent = `Map Info ${newVisibility ? '▲' : '▼'}`;
        
        logger.debug('MapControlsPanel', `Map Info section ${newVisibility ? 'expanded' : 'collapsed'}`);
    }

    public update(data?: any): void {
        // Update logic if needed
    }
}
