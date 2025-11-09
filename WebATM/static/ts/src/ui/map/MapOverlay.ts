import { AircraftData, DisplayOptions, RouteData } from '../../data/types';
import { MapDisplay } from './MapDisplay';
import { AircraftRenderer } from './aircraft/AircraftRenderer';
import { AircraftRoutes } from './aircraft/AircraftRoutes';
import { AIRCRAFT_SHAPES } from './aircraft/AircraftShapes';
import { StateManager } from '../../core/StateManager';
import { logger } from '../../utils/Logger';

/**
 * MapOverlay - Handles the map overlay information display
 *
 * Manages the overlay that shows aircraft count, conflicts, intrusions,
 * cursor position, and projection toggle functionality.
 * Also coordinates aircraft rendering and route visualization on the map.
 */
export class MapOverlay {
    private mapDisplay: MapDisplay;
    private stateManager: StateManager;
    private aircraftRenderer: AircraftRenderer | null = null;
    private aircraftRoutes: AircraftRoutes | null = null;
    private aircraftCountElement: HTMLElement | null;
    private conflictCountElement: HTMLElement | null;
    private conflictTotalElement: HTMLElement | null;
    private intrusionCountElement: HTMLElement | null;
    private intrusionTotalElement: HTMLElement | null;
    private cursorPositionElement: HTMLElement | null;
    private projectionToggleButton: HTMLElement | null;

    constructor(mapDisplay: MapDisplay, stateManager: StateManager) {
        this.mapDisplay = mapDisplay;
        this.stateManager = stateManager;

        // Get references to all overlay elements
        this.aircraftCountElement = document.getElementById('aircraft-count');
        this.conflictCountElement = document.getElementById('conflict-count');
        this.conflictTotalElement = document.getElementById('conflict-total');
        this.intrusionCountElement = document.getElementById('intrusion-count');
        this.intrusionTotalElement = document.getElementById('intrusion-total');
        this.cursorPositionElement = document.getElementById('cursor-position');
        this.projectionToggleButton = document.getElementById('projection-toggle');
    }

    /**
     * Initialize the map overlay
     * Sets up event listeners and initial state
     * @param displayOptions - Display options for aircraft rendering
     */
    public initialize(displayOptions: DisplayOptions): void {
        // Set up projection toggle button
        this.setupProjectionToggle();

        // Set up cursor tracking
        this.setupCursorTracking();

        // Set initial values
        this.updateAircraftCount(0);
        this.updateConflictCounts(0, 0);
        this.updateIntrusionCounts(0, 0);
        this.updateCursorPosition(null, null);

        // Initialize aircraft routes FIRST so they appear below aircraft
        this.initializeAircraftRoutes(displayOptions);

        // Initialize aircraft renderer LAST so aircraft appear on top
        this.initializeAircraftRenderer(displayOptions);

        logger.debug('MapOverlay', 'MapOverlay initialized');
    }

    /**
     * Initialize the aircraft renderer
     * @param displayOptions - Display options for aircraft rendering
     */
    private initializeAircraftRenderer(displayOptions: DisplayOptions): void {
        const map = this.mapDisplay.getMap();
        if (!map) {
            logger.warn('MapOverlay', 'Cannot initialize aircraft renderer: map not available');
            return;
        }

        // Get the shape drawer based on the selected shape
        const shapeConfig = AIRCRAFT_SHAPES[displayOptions.aircraftShape];
        const shapeDrawer = shapeConfig ? shapeConfig.drawer : AIRCRAFT_SHAPES.chevron.drawer;

        this.aircraftRenderer = new AircraftRenderer(map, displayOptions, shapeDrawer, this.stateManager);
        // Force immediate initialization since we're being called from the map load callback
        this.aircraftRenderer.initialize(true);

        logger.debug('MapOverlay', 'Aircraft renderer initialized with shape:', displayOptions.aircraftShape);
    }

    /**
     * Initialize the aircraft routes
     * @param displayOptions - Display options for route rendering
     */
    private initializeAircraftRoutes(displayOptions: DisplayOptions): void {
        const map = this.mapDisplay.getMap();
        if (!map) {
            logger.warn('MapOverlay', 'Cannot initialize aircraft routes: map not available');
            return;
        }

        this.aircraftRoutes = new AircraftRoutes(map, displayOptions);
        this.aircraftRoutes.setupLayers();

        logger.debug('MapOverlay', 'Aircraft routes initialized');
    }

    /**
     * Set up the projection toggle button
     */
    private setupProjectionToggle(): void {
        if (!this.projectionToggleButton) {
            logger.warn('MapOverlay', 'Projection toggle button not found');
            return;
        }

        // Set initial button state
        this.updateProjectionButton();

        // Add click event listener
        this.projectionToggleButton.addEventListener('click', () => {
            this.handleProjectionToggle();
        });

        logger.debug('MapOverlay', 'Projection toggle button initialized');
    }

    /**
     * Handle projection toggle button click
     */
    private handleProjectionToggle(): void {
        if (!this.mapDisplay.isInitialized()) {
            logger.warn('MapOverlay', 'Cannot toggle projection: map not initialized');
            return;
        }

        // Toggle the projection
        this.mapDisplay.toggleProjection();

        // Update button appearance
        this.updateProjectionButton();

        logger.info('MapOverlay', 'Projection toggled to:', this.mapDisplay.getProjection());
    }

    /**
     * Update projection toggle button based on current projection
     */
    private updateProjectionButton(): void {
        if (!this.projectionToggleButton) return;

        const currentProjection = this.mapDisplay.getProjection();

        if (currentProjection === 'globe') {
            // Currently in globe view, button shows option to switch to 2D
            this.projectionToggleButton.innerHTML = '🗺️';
            this.projectionToggleButton.title = 'Switch to 2D View';
        } else {
            // Currently in 2D view, button shows option to switch to globe
            this.projectionToggleButton.innerHTML = '🌐';
            this.projectionToggleButton.title = 'Switch to Globe View';
        }
    }

    /**
     * Set up cursor position tracking on the map
     */
    private setupCursorTracking(): void {
        const map = this.mapDisplay.getMap();
        if (!map) {
            logger.warn('MapOverlay', 'Cannot set up cursor tracking: map not available');
            return;
        }

        // Track mouse movement over the map
        map.on('mousemove', (e) => {
            const { lng, lat } = e.lngLat;
            this.updateCursorPosition(lat, lng);
        });

        // Clear cursor position when mouse leaves the map
        map.on('mouseleave', () => {
            this.updateCursorPosition(null, null);
        });

        logger.debug('MapOverlay', 'Cursor tracking initialized');
    }

    /**
     * Update aircraft count display
     * @param count - Number of aircraft
     */
    public updateAircraftCount(count: number): void {
        if (this.aircraftCountElement) {
            this.aircraftCountElement.textContent = count.toString();
        }
    }

    /**
     * Update conflict counts display
     * @param current - Current number of conflicts
     * @param total - Total number of conflicts detected
     */
    public updateConflictCounts(current: number, total: number): void {
        if (this.conflictCountElement) {
            this.conflictCountElement.textContent = current.toString();
        }
        if (this.conflictTotalElement) {
            this.conflictTotalElement.textContent = total.toString();
        }
    }

    /**
     * Update intrusion counts display
     * @param current - Current number of intrusions
     * @param total - Total number of intrusions detected
     */
    public updateIntrusionCounts(current: number, total: number): void {
        if (this.intrusionCountElement) {
            this.intrusionCountElement.textContent = current.toString();
        }
        if (this.intrusionTotalElement) {
            this.intrusionTotalElement.textContent = total.toString();
        }
    }

    /**
     * Update cursor position display
     * @param lat - Latitude (null to clear)
     * @param lng - Longitude (null to clear)
     */
    public updateCursorPosition(lat: number | null, lng: number | null): void {
        if (!this.cursorPositionElement) return;

        if (lat === null || lng === null) {
            this.cursorPositionElement.textContent = '--';
        } else {
            // Format to 4 decimal places
            const latStr = lat.toFixed(4);
            const lngStr = lng.toFixed(4);
            this.cursorPositionElement.textContent = `${latStr}°, ${lngStr}°`;
        }
    }

    /**
     * Update overlay from aircraft data
     * @param aircraftData - Aircraft data containing counts
     */
    public updateFromAircraftData(aircraftData: AircraftData): void {
        // Update aircraft count
        const aircraftCount = aircraftData.id ? aircraftData.id.length : 0;
        this.updateAircraftCount(aircraftCount);

        // Update conflict counts
        const conflictCurrent = aircraftData.nconf_cur !== undefined ? aircraftData.nconf_cur : 0;
        const conflictTotal = aircraftData.nconf_tot !== undefined ? aircraftData.nconf_tot : 0;
        this.updateConflictCounts(conflictCurrent, conflictTotal);

        // Update intrusion counts
        const intrusionCurrent = aircraftData.nlos_cur !== undefined ? aircraftData.nlos_cur : 0;
        const intrusionTotal = aircraftData.nlos_tot !== undefined ? aircraftData.nlos_tot : 0;
        this.updateIntrusionCounts(intrusionCurrent, intrusionTotal);

        // Check if selected aircraft still exists
        const selectedAircraft = this.stateManager.getState().selectedAircraft;
        if (selectedAircraft && aircraftData.id && !aircraftData.id.includes(selectedAircraft)) {
            // Selected aircraft was deleted - deselect it and clear routes
            logger.info('MapOverlay', `Aircraft ${selectedAircraft} was deleted - clearing selection and routes`);
            this.stateManager.setSelectedAircraft(null);
            if (this.aircraftRoutes) {
                this.aircraftRoutes.clearRouteDisplay();
            }
            if (this.aircraftRenderer) {
                this.aircraftRenderer.setSelectedAircraft(null);
            }
        }

        // Update aircraft renderer with new data
        if (this.aircraftRenderer) {
            this.aircraftRenderer.updateAircraftDisplay(aircraftData);
        }
    }

    /**
     * Set selected aircraft
     * @param aircraftId - Aircraft ID to select (null to deselect)
     */
    public setSelectedAircraft(aircraftId: string | null): void {
        if (this.aircraftRenderer) {
            this.aircraftRenderer.setSelectedAircraft(aircraftId);
        }
        if (this.aircraftRoutes) {
            this.aircraftRoutes.setSelectedAircraft(aircraftId);
        }
    }

    /**
     * Update route data from server
     * @param data - Route data for an aircraft
     */
    public updateRouteData(data: RouteData): void {
        if (this.aircraftRoutes) {
            this.aircraftRoutes.updateRouteData(data);
        }
    }

    /**
     * Update display options for aircraft rendering and routes
     * @param options - Display options to update
     */
    public updateDisplayOptions(options: Partial<DisplayOptions>): void {
        if (this.aircraftRenderer) {
            this.aircraftRenderer.updateDisplayOptions(options);

            // If aircraft shape changed, update the shape
            if (options.aircraftShape) {
                const shapeConfig = AIRCRAFT_SHAPES[options.aircraftShape];
                if (shapeConfig) {
                    this.aircraftRenderer.setAircraftShape(shapeConfig.drawer);
                    logger.info('MapOverlay', 'Aircraft shape updated to:', options.aircraftShape);
                }
            }
        }

        // Update routes with new display options
        if (this.aircraftRoutes) {
            // Merge with existing options to create full DisplayOptions
            const fullOptions = { ...this.stateManager.getDisplayOptions(), ...options };
            this.aircraftRoutes.updateDisplayOptions(fullOptions);
        }
    }

    /**
     * Handle map style change
     * Notifies aircraft renderer and routes to recreate layers
     */
    public onStyleChange(): void {
        // Re-create route layers FIRST so they appear below aircraft
        if (this.aircraftRoutes) {
            this.aircraftRoutes.setupLayers();
        }
        // Re-create aircraft layers LAST so they appear on top
        if (this.aircraftRenderer) {
            this.aircraftRenderer.onStyleChange();
        }
    }

    /**
     * Get the aircraft renderer instance
     */
    public getAircraftRenderer(): AircraftRenderer | null {
        return this.aircraftRenderer;
    }

    /**
     * Reset all displays to default values
     */
    public reset(): void {
        this.updateAircraftCount(0);
        this.updateConflictCounts(0, 0);
        this.updateIntrusionCounts(0, 0);
        this.updateCursorPosition(null, null);
    }

    /**
     * Clean up resources
     */
    public destroy(): void {
        if (this.aircraftRenderer) {
            this.aircraftRenderer.destroy();
            this.aircraftRenderer = null;
        }
        if (this.aircraftRoutes) {
            this.aircraftRoutes.clearRouteDisplay();
            this.aircraftRoutes = null;
        }
    }
}
