import type { Map as MapLibreMap } from 'maplibre-gl';
import { AircraftData, DisplayOptions, RouteData } from '../../data/types';
import { MapDisplay } from './MapDisplay';
import { AircraftRenderer } from './aircraft/AircraftRenderer';
import { Aircraft2DRenderer } from './aircraft/Aircraft2DRenderer';
import { AircraftRendererFactory } from './aircraft/AircraftRendererFactory';
import type { IEntityRenderer } from './rendering/IEntityRenderer';
import { AircraftRoutes } from './aircraft/AircraftRoutes';
import type { AircraftRoute3DRenderer } from './aircraft/AircraftRoute3DRenderer';
import { AIRCRAFT_SHAPES } from './aircraft/AircraftShapes';
import { StateManager } from '../../core/StateManager';
import { logger } from '../../utils/Logger';

/**
 * MapOverlay - Handles the map overlay information display
 *
 * Manages the overlay that shows aircraft count, conflicts, intrusions,
 * cursor position, and projection toggle functionality.
 * Also coordinates aircraft rendering and route visualization on the map.
 *
 * Rendering Architecture:
 * - 2D renderer is always active
 * - 3D renderer is an optional overlay that can be toggled
 * - When 3D overlay is enabled, both renderers update simultaneously
 */
export class MapOverlay {
    private mapDisplay: MapDisplay;
    private stateManager: StateManager;
    private aircraft2DRenderer: IEntityRenderer<AircraftData> | null = null;
    private aircraft3DRenderer: IEntityRenderer<AircraftData> | null = null;
    private aircraftRoutes: AircraftRoutes | null = null;
    private aircraftRoute3DRenderer: AircraftRoute3DRenderer | null = null;
    // Track if 3D overlay is currently active
    private is3DOverlayActive: boolean = false;
    private is3DOverlayTransitioning: boolean = false;
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
    public async initialize(displayOptions: DisplayOptions): Promise<void> {
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
        await this.initializeAircraftRenderer(displayOptions);

        logger.debug('MapOverlay', 'MapOverlay initialized');
    }

    /**
     * Initialize the aircraft renderers.
     * Always creates 2D renderer, optionally enables 3D overlay.
     */
    private async initializeAircraftRenderer(displayOptions: DisplayOptions): Promise<void> {
        const map = this.mapDisplay.getMap();
        if (!map) {
            logger.warn('MapOverlay', 'Cannot initialize aircraft renderer: map not available');
            return;
        }

        this.aircraft2DRenderer = await AircraftRendererFactory.create(
            displayOptions,
            this.stateManager,
            false // request 2D
        );
        this.aircraft2DRenderer.initialize(map);
        logger.debug('MapOverlay', '2D aircraft renderer initialized (always active)');

        if (displayOptions.show3DOverlay) {
            await this.enable3DOverlay(displayOptions);
        }

        logger.debug('MapOverlay', `3D overlay: ${this.is3DOverlayActive ? 'enabled' : 'disabled'}`);
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
            // Handle 2D renderer selected aircraft
            if (this.aircraft2DRenderer && this.aircraft2DRenderer.getType() === '2d') {
                const renderer2D = this.getAircraftRenderer() as AircraftRenderer;
                if (renderer2D) {
                    renderer2D.setSelectedAircraft(null);
                }
            }
            // Clear 3D route renderer state for the deleted aircraft
            if (this.aircraftRoute3DRenderer) {
                this.aircraftRoute3DRenderer.setSelectedAircraft(null);
                this.aircraftRoute3DRenderer.updateRouteData(null);
            }
        }

        // Update aircraft renderers with new data
        // Convert AircraftData to Map for interface compatibility
        if (aircraftData.id) {
            const aircraftMap = new Map<string, AircraftData>();
            // For now, pass the entire AircraftData as a single entry
            // The renderer will handle converting it to individual aircraft
            aircraftMap.set('batch', aircraftData);

            const simTime = this.stateManager.getState().simInfo?.simt || 0;

            // Always update 2D renderer
            if (this.aircraft2DRenderer) {
                this.aircraft2DRenderer.updateEntities(aircraftMap, simTime);
            }

            // Update 3D renderer if active
            if (this.is3DOverlayActive && this.aircraft3DRenderer) {
                this.aircraft3DRenderer.updateEntities(aircraftMap, simTime);
                // Debug: Confirm 3D renderer is receiving aircraft data after reset
                if (aircraftCount > 0) {
                    logger.debug('MapOverlay', `3D renderer updated with ${aircraftCount} aircraft`);
                }
            } else if (this.is3DOverlayActive && !this.aircraft3DRenderer) {
                // This would indicate a state inconsistency
                logger.warn('MapOverlay', '3D overlay marked active but no 3D renderer exists - this should not happen');
            }

            // Feed selected aircraft position/altitude into the 3D route renderer
            // so unconstrained route segments track the aircraft's current altitude.
            if (this.is3DOverlayActive && this.aircraftRoute3DRenderer) {
                const selectedId = this.stateManager.getState().selectedAircraft;
                if (selectedId && aircraftData.id) {
                    const idx = aircraftData.id.indexOf(selectedId);
                    if (idx >= 0) {
                        this.aircraftRoute3DRenderer.setAircraftState(
                            aircraftData.lat[idx],
                            aircraftData.lon[idx],
                            aircraftData.alt[idx]
                        );
                    }
                }
            }
        }
    }

    /**
     * Set selected aircraft
     * @param aircraftId - Aircraft ID to select (null to deselect)
     */
    public setSelectedAircraft(aircraftId: string | null): void {
        // Handle 2D renderer which has setSelectedAircraft method
        if (this.aircraft2DRenderer && this.aircraft2DRenderer.getType() === '2d') {
            const renderer2D = this.getAircraftRenderer() as AircraftRenderer;
            if (renderer2D) {
                renderer2D.setSelectedAircraft(aircraftId);
            }
        }
        // TODO: 3D renderer will handle selection through display options or separate method

        if (this.aircraftRoutes) {
            this.aircraftRoutes.setSelectedAircraft(aircraftId);
        }

        if (this.aircraftRoute3DRenderer) {
            this.aircraftRoute3DRenderer.setSelectedAircraft(aircraftId);
            this.seedAircraftStateFor3DRoute();
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

        if (this.aircraftRoute3DRenderer) {
            this.aircraftRoute3DRenderer.updateRouteData(data);
        }
    }

    /**
     * Get the current route data for the selected aircraft (if any).
     * Used by RouteDrawingManager to anchor a leader line from the last
     * existing waypoint when appending to an aircraft that already has a route.
     */
    public getRouteData(): RouteData | null {
        return this.aircraftRoutes ? this.aircraftRoutes.getRouteData() : null;
    }

    /**
     * Update display options for aircraft rendering and routes
     * @param options - Display options to update
     */
    public async updateDisplayOptions(options: Partial<DisplayOptions>): Promise<void> {
        // Check if 3D overlay toggle changed
        if (options.show3DOverlay !== undefined) {
            const currentlyActive = this.is3DOverlayActive;
            const shouldBeActive = options.show3DOverlay;

            if (shouldBeActive && !currentlyActive) {
                logger.info('MapOverlay', 'Enabling 3D overlay');
                const fullOptions = { ...this.stateManager.getDisplayOptions(), ...options };
                await this.enable3DOverlay(fullOptions);
            } else if (!shouldBeActive && currentlyActive) {
                logger.info('MapOverlay', 'Disabling 3D overlay');
                await this.disable3DOverlay();
            }
        }

        // Get full display options by merging partial with current
        const fullOptions = { ...this.stateManager.getDisplayOptions(), ...options };

        // Always update 2D renderer
        if (this.aircraft2DRenderer) {
            this.aircraft2DRenderer.updateDisplayOptions(fullOptions);

            // If aircraft shape changed, update the shape
            if (options.aircraftShape && this.aircraft2DRenderer.getType() === '2d') {
                const renderer2D = this.getAircraftRenderer() as AircraftRenderer;
                if (renderer2D) {
                    const shapeConfig = AIRCRAFT_SHAPES[options.aircraftShape];
                    if (shapeConfig) {
                        renderer2D.setAircraftShape(shapeConfig.drawer);
                        logger.info('MapOverlay', 'Aircraft shape updated to:', options.aircraftShape);
                    }
                }
            }
        }

        // Update 3D renderer if active
        if (this.is3DOverlayActive && this.aircraft3DRenderer) {
            this.aircraft3DRenderer.updateDisplayOptions(fullOptions);
        }

        // Update routes with new display options
        if (this.aircraftRoutes) {
            this.aircraftRoutes.updateDisplayOptions(fullOptions);
        }

        // Update 3D route renderer if active
        if (this.is3DOverlayActive && this.aircraftRoute3DRenderer) {
            this.aircraftRoute3DRenderer.updateDisplayOptions(fullOptions);
        }
    }

    /**
     * Enable 3D overlay rendering alongside the always-active 2D renderer.
     */
    private async enable3DOverlay(displayOptions: DisplayOptions): Promise<void> {
        // Async mutex: enable3DOverlay is called from two paths on the
        // same user click (DisplayOptionsPanel's direct call + the
        // stateManager.displayOptions subscription in App.ts). Without
        // this guard, both reach the factory-create await before
        // is3DOverlayActive flips to true, causing duplicate onAdd calls
        // that each scale the canvas by devicePixelRatio.
        if (this.is3DOverlayActive || this.is3DOverlayTransitioning) {
            logger.debug('MapOverlay', '3D overlay already active or transitioning');
            return;
        }

        const map = this.mapDisplay.getMap();
        if (!map) {
            logger.warn('MapOverlay', 'Cannot enable 3D overlay: map not available');
            return;
        }

        this.is3DOverlayTransitioning = true;
        try {
            await this.doEnable3DOverlay(displayOptions, map);
        } finally {
            this.is3DOverlayTransitioning = false;
        }
    }

    private async doEnable3DOverlay(displayOptions: DisplayOptions, map: MapLibreMap): Promise<void> {
        logger.info('MapOverlay', 'Enabling 3D overlay...');

        // Save current view state before adding 3D layer
        // Three.js WebGLRenderer initialization can disrupt MapLibre's viewport
        const savedCenter = map.getCenter();
        const savedZoom = map.getZoom();
        const savedPitch = map.getPitch();
        const savedBearing = map.getBearing();

        const snapshot = (tag: string) => {
            const canvas = map.getCanvas();
            const container = map.getContainer();
            logger.info(
                '3D-DIAG',
                `[${tag}] canvas=${canvas.width}x${canvas.height} ` +
                    `style=${canvas.style.width}x${canvas.style.height} ` +
                    `container=${container.clientWidth}x${container.clientHeight} ` +
                    `dpr=${window.devicePixelRatio} ` +
                    `isStyleLoaded=${map.isStyleLoaded()}`
            );
        };

        snapshot('enable3DOverlay:start');

        // Create 3D renderer
        this.aircraft3DRenderer = await AircraftRendererFactory.create(
            displayOptions,
            this.stateManager,
            true // request 3D
        );

        snapshot('enable3DOverlay:after-factory-create');

        this.aircraft3DRenderer.initialize(map);
        this.is3DOverlayActive = true;

        snapshot('enable3DOverlay:after-aircraft3D-initialize');

        // Also create and initialize the 3D route renderer so the selected
        // aircraft's route is rendered at altitude alongside the aircraft.
        this.aircraftRoute3DRenderer = await AircraftRendererFactory.createRoute3D(displayOptions);
        if (this.aircraftRoute3DRenderer) {
            this.aircraftRoute3DRenderer.initialize(map);

            // Seed the 3D route renderer with current selection + route + aircraft state.
            const selectedId = this.stateManager.getState().selectedAircraft;
            this.aircraftRoute3DRenderer.setSelectedAircraft(selectedId);

            const existingRoute = this.aircraftRoutes?.getRouteData() ?? null;
            this.aircraftRoute3DRenderer.updateRouteData(existingRoute);

            this.seedAircraftStateFor3DRoute();
        }

        snapshot('enable3DOverlay:after-route3D-initialize');

        // Restore view state after map settles from adding 3D layer
        // Three.js WebGLRenderer initialization disrupts MapLibre's viewport/projection.
        // Using 'idle' event ensures the map has fully settled before we restore.
        map.once('idle', () => {
            snapshot('idle-handler:before-jumpTo');
            map.jumpTo({
                center: savedCenter,
                zoom: savedZoom,
                pitch: savedPitch,
                bearing: savedBearing
            });
            snapshot('idle-handler:after-jumpTo-before-resize');
            this.mapDisplay.resize();
            snapshot('idle-handler:after-resize');
        });

        // Safety net: the 3D custom layer keeps the map in a continuous
        // render loop, so 'idle' can fire too early (before Three.js has
        // sized its GL context) and the canvas ends up scaled from the
        // container, appearing blurry until the user resizes the panel.
        // map.resize() is idempotent, so this extra call is harmless when
        // 'idle' fired at the right time.
        requestAnimationFrame(() => {
            snapshot('rAF-safety-net:before-resize');
            this.mapDisplay.resize();
            snapshot('rAF-safety-net:after-resize');
        });

        // Extra late snapshot so we can see whether the canvas ends up
        // matching the container, or stays out of sync.
        setTimeout(() => snapshot('late-500ms'), 500);

        // Sync with current aircraft data if available
        const currentAircraftData = this.stateManager.getState().aircraftData;
        const currentSimTime = this.stateManager.getState().simInfo?.simt || 0;
        if (currentAircraftData && currentAircraftData.id) {
            const aircraftMap = new Map<string, AircraftData>();
            aircraftMap.set('batch', currentAircraftData);
            this.aircraft3DRenderer.updateEntities(aircraftMap, currentSimTime);
            logger.debug('MapOverlay', `3D overlay initialized with ${currentAircraftData.id.length} existing aircraft`);
        } else {
            logger.debug('MapOverlay', '3D overlay enabled with no existing aircraft data');
        }

        logger.info('MapOverlay', '3D overlay enabled successfully');
    }

    /**
     * Push the selected aircraft's current position/altitude to the 3D route
     * renderer from the state manager. Used when enabling the overlay.
     */
    private seedAircraftStateFor3DRoute(): void {
        if (!this.aircraftRoute3DRenderer) return;

        const selectedId = this.stateManager.getState().selectedAircraft;
        const aircraftData = this.stateManager.getState().aircraftData;
        if (!selectedId || !aircraftData || !aircraftData.id) return;

        const index = aircraftData.id.indexOf(selectedId);
        if (index < 0) return;

        this.aircraftRoute3DRenderer.setAircraftState(
            aircraftData.lat[index],
            aircraftData.lon[index],
            aircraftData.alt[index]
        );
    }

    /**
     * Disable 3D overlay rendering
     * Destroys the 3D renderer, 2D renderer remains active
     */
    private async disable3DOverlay(): Promise<void> {
        // Mirror the enable3DOverlay mutex: the same dual-call path from
        // DisplayOptionsPanel + App.ts state subscription fires here too.
        if (!this.is3DOverlayActive || this.is3DOverlayTransitioning) {
            logger.debug('MapOverlay', '3D overlay already disabled or transitioning');
            return;
        }

        this.is3DOverlayTransitioning = true;
        try {
            logger.info('MapOverlay', 'Disabling 3D overlay...');

            // Save current view state before removing the 3D layer. Removing the
            // Three.js custom layer disrupts MapLibre's viewport/projection the same
            // way adding it does, which otherwise snaps the map back to its default
            // view. We restore the saved view once the map settles.
            const map = this.mapDisplay.getMap();
            const savedView = map
                ? {
                      center: map.getCenter(),
                      zoom: map.getZoom(),
                      pitch: map.getPitch(),
                      bearing: map.getBearing()
                  }
                : null;

            if (this.aircraftRoute3DRenderer) {
                this.aircraftRoute3DRenderer.destroy();
                this.aircraftRoute3DRenderer = null;
            }

            if (this.aircraft3DRenderer) {
                this.aircraft3DRenderer.destroy();
                this.aircraft3DRenderer = null;
            }

            this.is3DOverlayActive = false;

            // Restore the view after the map settles from removing the 3D layer.
            if (map && savedView) {
                map.once('idle', () => {
                    map.jumpTo(savedView);
                    this.mapDisplay.resize();
                });
            }

            logger.info('MapOverlay', '3D overlay disabled');
        } finally {
            this.is3DOverlayTransitioning = false;
        }
    }

    /**
     * Toggle 3D overlay on/off
     * Public method for UI controls to toggle 3D overlay
     * @returns Promise that resolves when toggle is complete
     */
    public async toggle3DOverlay(): Promise<boolean> {
        const newState = !this.is3DOverlayActive;
        const displayOptions = this.stateManager.getDisplayOptions();

        if (newState) {
            await this.enable3DOverlay(displayOptions);
        } else {
            await this.disable3DOverlay();
        }

        return this.is3DOverlayActive;
    }

    /**
     * Check if 3D overlay is currently active
     */
    public is3DOverlayEnabled(): boolean {
        return this.is3DOverlayActive;
    }

    /**
     * Switch between 2D and 3D rendering modes (deprecated)
     * Kept for backwards compatibility - now maps to toggle3DOverlay
     * @param mode - The rendering mode to switch to
     * @deprecated Use toggle3DOverlay() instead
     */
    public async switchRenderMode(mode: '2d' | '3d'): Promise<void> {
        logger.warn('MapOverlay', 'switchRenderMode is deprecated, use toggle3DOverlay instead');
        if (mode === '3d' && !this.is3DOverlayActive) {
            await this.enable3DOverlay(this.stateManager.getDisplayOptions());
        } else if (mode === '2d' && this.is3DOverlayActive) {
            await this.disable3DOverlay();
        }
    }

    /**
     * Handle map style change
     * Notifies aircraft renderers and routes to recreate layers
     */
    public onStyleChange(): void {
        // Re-create route layers FIRST so they appear below aircraft
        if (this.aircraftRoutes) {
            this.aircraftRoutes.setupLayers();
        }
        // Re-create 2D aircraft layers
        if (this.aircraft2DRenderer) {
            this.aircraft2DRenderer.onStyleChange();
        }
        // Re-create 3D aircraft layers if active
        if (this.is3DOverlayActive && this.aircraft3DRenderer) {
            this.aircraft3DRenderer.onStyleChange();
        }
        // Re-create 3D route layer if active
        if (this.is3DOverlayActive && this.aircraftRoute3DRenderer) {
            this.aircraftRoute3DRenderer.onStyleChange();
        }
    }

    /**
     * Get the 2D aircraft renderer instance
     * Always returns the 2D renderer (which is always active)
     */
    public getAircraftRenderer(): AircraftRenderer | null {
        if (this.aircraft2DRenderer instanceof Aircraft2DRenderer) {
            return this.aircraft2DRenderer.getRenderer();
        }
        return null;
    }

    /**
     * Clear the displayed route for the selected aircraft, if any.
     */
    public clearRouteDisplay(): void {
        this.aircraftRoutes?.clearRouteDisplay();
    }

    /**
     * Reset all displays to default values
     */
    public reset(): void {
        this.updateAircraftCount(0);
        this.updateConflictCounts(0, 0);
        this.updateIntrusionCounts(0, 0);
        this.updateCursorPosition(null, null);

        // SIMPLE APPROACH: For 3D renderer, just destroy and recreate on reset
        // This is cleaner and more reliable than trying to clear individual models
        if (this.is3DOverlayActive && this.aircraft3DRenderer) {
            logger.info('MapOverlay', 'Recreating 3D renderer due to simulation reset');
            this.recreate3DRenderer();
        }

        // Clear selected aircraft and routes
        this.setSelectedAircraft(null);
        if (this.aircraftRoutes) {
            this.aircraftRoutes.clearRouteDisplay();
        }
    }

    /**
     * Destroy and recreate the 3D renderer
     * Used during simulation reset for clean state
     */
    private async recreate3DRenderer(): Promise<void> {
        if (!this.is3DOverlayActive || !this.aircraft3DRenderer) {
            return;
        }

        logger.debug('MapOverlay', 'Destroying existing 3D renderer...');

        // Destroy the current 3D route renderer too so enable3DOverlay can recreate it cleanly
        if (this.aircraftRoute3DRenderer) {
            this.aircraftRoute3DRenderer.destroy();
            this.aircraftRoute3DRenderer = null;
        }

        // Destroy the current 3D renderer
        this.aircraft3DRenderer.destroy();
        this.aircraft3DRenderer = null;
        this.is3DOverlayActive = false; // CRITICAL: Reset flag so enable3DOverlay() will work

        // Recreate the 3D renderer with current display options
        const displayOptions = this.stateManager.getDisplayOptions();
        await this.enable3DOverlay(displayOptions);

        logger.debug('MapOverlay', '3D renderer recreated successfully');
    }

    /**
     * Clean up resources
     */
    public destroy(): void {
        // Clean up 2D renderer
        if (this.aircraft2DRenderer) {
            this.aircraft2DRenderer.destroy();
            this.aircraft2DRenderer = null;
        }
        // Clean up 3D route renderer if active
        if (this.aircraftRoute3DRenderer) {
            this.aircraftRoute3DRenderer.destroy();
            this.aircraftRoute3DRenderer = null;
        }
        // Clean up 3D renderer if active
        if (this.aircraft3DRenderer) {
            this.aircraft3DRenderer.destroy();
            this.aircraft3DRenderer = null;
        }
        this.is3DOverlayActive = false;

        if (this.aircraftRoutes) {
            this.aircraftRoutes.clearRouteDisplay();
            this.aircraftRoutes = null;
        }
    }
}
