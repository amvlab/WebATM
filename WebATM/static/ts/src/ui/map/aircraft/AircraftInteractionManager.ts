/**
 * AircraftInteractionManager - Handles aircraft selection and camera control
 *
 * This manager provides UNIFIED interaction behavior across all sources:
 *
 * SINGLE CLICK (Map or Panel):
 * - Click on new aircraft: Select + Simple zoom with adaptive zoom level
 * - Click on selected aircraft: Unselect + Stop following
 *
 * DOUBLE CLICK (Map or Panel):
 * - Click on any aircraft: Select + Fancy zoom effect + Activate follow mode
 * - Zoom effect: zoom-out → pan → zoom-in (smooth visual transition)
 *
 * OTHER INTERACTIONS:
 * - Click on empty map: Unselect + Stop following
 * - User pan/drag: Stop following (allow manual control)
 * - Aircraft disappears: Auto-stop following
 *
 * Architecture:
 * - Panels (TrafficListPanel, ConflictsPanel) handle UI clicks and emit events
 * - This manager handles ALL camera movements and map interactions
 * - StateManager coordinates selection state across all components
 * - Consistent behavior regardless of interaction source (map/panel)
 */

import { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import { MapDisplay } from '../MapDisplay';
import { StateManager } from '../../../core/StateManager';
import { SocketManager } from '../../../core/SocketManager';
import { AircraftData } from '../../../data/types';
import { logger } from '../../../utils/Logger';

export interface AircraftClickEvent {
    aircraftId: string;
    index: number;
}

export class AircraftInteractionManager {
    private mapDisplay: MapDisplay;
    private stateManager: StateManager;
    private socketManager: SocketManager;
    private map: MapLibreMap | null = null;

    // Follow mode state
    private followingAircraft: string | null = null;
    private isUserInteracting: boolean = false;

    // Click debouncing for map clicks
    private lastMapClickTime: number = 0;
    private lastMapClickAircraft: string | null = null;

    // Track when we explicitly send POS commands to distinguish from unsolicited ROUTEDATA
    private lastExplicitPosCommand: string | null = null;
    private lastExplicitPosTime: number = 0;

    constructor(
        mapDisplay: MapDisplay,
        stateManager: StateManager,
        socketManager: SocketManager
    ) {
        this.mapDisplay = mapDisplay;
        this.stateManager = stateManager;
        this.socketManager = socketManager;
        this.map = this.mapDisplay.getMap();

        if (!this.map) {
            logger.error('AircraftInteractionManager', 'AircraftInteractionManager: Map not initialized');
            return;
        }

        this.setupMapEventHandlers();
        this.setupPanelEventListeners();
        this.setupStateSubscriptions();

        logger.debug('AircraftInteractionManager', 'AircraftInteractionManager initialized');
    }

    /**
     * Set up map event handlers for aircraft clicks
     */
    private setupMapEventHandlers(): void {
        if (!this.map) return;

        // Single click on aircraft - select and zoom
        this.map.on('click', 'aircraft-points', (e: any) => {
            if (!e.features || e.features.length === 0) return;

            const aircraftId = e.features[0].properties?.entity_id || e.features[0].properties?.callsign;
            if (aircraftId) {
                logger.debug('AircraftInteractionManager', 'MAP SINGLE CLICK:', aircraftId);
                this.handleMapAircraftClick(aircraftId, false);
            }
        });

        // Double click on aircraft - select, zoom, and follow
        this.map.on('dblclick', 'aircraft-points', (e: any) => {
            if (!e.features || e.features.length === 0) return;

            const aircraftId = e.features[0].properties?.entity_id || e.features[0].properties?.callsign;
            if (aircraftId) {
                logger.debug('AircraftInteractionManager', 'MAP DOUBLE CLICK:', aircraftId);
                this.handleMapAircraftClick(aircraftId, true);
            }
        });

        // Prevent default map zoom on aircraft double-click
        this.map.on('dblclick', (e: MapMouseEvent) => {
            const features = this.map!.queryRenderedFeatures(e.point, {
                layers: ['aircraft-points']
            });

            if (features.length > 0) {
                logger.verbose('AircraftInteractionManager', '🛑 Preventing default map zoom on aircraft double-click');
                e.preventDefault();
            }
        });

        // Click on empty map - unselect aircraft
        this.map.on('click', (e: MapMouseEvent) => {
            // Small delay to let aircraft-specific click handlers run first
            setTimeout(() => {
                const features = this.map!.queryRenderedFeatures(e.point, {
                    layers: ['aircraft-points']
                });

                // If click was not on an aircraft, unselect and stop following
                if (features.length === 0) {
                    logger.debug('AircraftInteractionManager', 'Empty map click - unselecting aircraft');
                    const currentSelection = this.stateManager.getState().selectedAircraft;
                    if (currentSelection) {
                        // Send POS command to toggle route visibility off
                        this.requestRouteData(currentSelection);
                    }
                    this.stopFollowing();
                    this.stateManager.setSelectedAircraft(null);
                }
            }, 50);
        });

        // Stop following on user drag
        this.map.on('dragstart', () => {
            this.isUserInteracting = true;
            this.stopFollowing();
        });

        this.map.on('dragend', () => {
            this.isUserInteracting = false;
        });

        // Change cursor on hover
        this.map.on('mouseenter', 'aircraft-points', () => {
            if (this.map) this.map.getCanvas().style.cursor = 'pointer';
        });

        this.map.on('mouseleave', 'aircraft-points', () => {
            if (this.map) this.map.getCanvas().style.cursor = '';
        });

        logger.debug('AircraftInteractionManager', 'Map event handlers set up');
    }

    /**
     * Set up listeners for panel events
     */
    private setupPanelEventListeners(): void {
        // Listen for single-click events from panels (TrafficListPanel, ConflictsPanel)
        document.addEventListener('aircraft-single-click', ((e: CustomEvent<AircraftClickEvent>) => {
            const { aircraftId } = e.detail;
            logger.debug('AircraftInteractionManager', '📋 Panel single-click event received:', aircraftId);

            // UNIFIED BEHAVIOR: Request route data + Simple zoom (same as map clicks)
            this.requestRouteData(aircraftId);
            this.zoomToAircraft(aircraftId, { follow: false, adaptive: true });
        }) as EventListener);

        // Listen for double-click events from panels
        document.addEventListener('aircraft-double-click', ((e: CustomEvent<AircraftClickEvent>) => {
            const { aircraftId } = e.detail;
            logger.debug('AircraftInteractionManager', '📋 Panel double-click event received:', aircraftId);

            // UNIFIED BEHAVIOR: Request route data + Fancy zoom effect + follow (same as map)
            this.requestRouteData(aircraftId);
            this.zoomToAircraftWithEffect(aircraftId, true);
        }) as EventListener);

        logger.debug('AircraftInteractionManager', 'Panel event listeners set up');
    }

    /**
     * Set up subscriptions to state changes
     */
    private setupStateSubscriptions(): void {
        // Subscribe to aircraft data updates for follow mode
        this.stateManager.subscribe('aircraftData', (newData) => {
            if (newData) {
                this.updateFollowing(newData);
            }
        });

        logger.debug('AircraftInteractionManager', 'State subscriptions set up');
    }

    /**
     * Handle map aircraft click
     * @param aircraftId - Aircraft ID
     * @param isDoubleClick - Whether this is a double-click
     */
    private handleMapAircraftClick(aircraftId: string, isDoubleClick: boolean): void {
        // Simple debounce for single clicks
        const now = Date.now();
        if (!isDoubleClick &&
            this.lastMapClickTime &&
            this.lastMapClickAircraft === aircraftId &&
            (now - this.lastMapClickTime) < 100) {
            logger.verbose('AircraftInteractionManager', '⚡ Debouncing rapid single click on', aircraftId);
            return;
        }
        this.lastMapClickTime = now;
        this.lastMapClickAircraft = aircraftId;

        const currentSelection = this.stateManager.getState().selectedAircraft;
        const isCurrentlySelected = currentSelection === aircraftId;

        if (isDoubleClick) {
            // UNIFIED BEHAVIOR: Double click = fancy zoom effect + follow + send POS
            logger.debug('AircraftInteractionManager', '🚀 Map double-click: selecting and following', aircraftId);

            this.stateManager.setSelectedAircraft(aircraftId);
            this.requestRouteData(aircraftId);  // Sends POS command
            this.zoomToAircraftWithEffect(aircraftId, true);

        } else {
            // UNIFIED BEHAVIOR: Single click = toggle selection with simple zoom
            if (isCurrentlySelected) {
                // DESELECT: Send POS command to toggle visibility OFF, then clear selection
                logger.debug('AircraftInteractionManager', '🔄 Map single-click: unselecting', aircraftId);
                this.requestRouteData(aircraftId);  // Sends POS command to toggle off
                this.stateManager.setSelectedAircraft(null);
                this.stopFollowing();
            } else {
                // SELECT new aircraft: Just send POS for new aircraft (don't send for old)
                logger.debug('AircraftInteractionManager', 'Map single-click: selecting', aircraftId);
                this.stateManager.setSelectedAircraft(aircraftId);
                this.requestRouteData(aircraftId);  // Sends POS command for new selection
                this.zoomToAircraft(aircraftId, { follow: false, adaptive: true });
            }
        }
    }

    /**
     * Zoom to aircraft with smart adaptive zoom
     * @param aircraftId - Aircraft ID
     * @param options - Zoom options
     */
    private zoomToAircraft(
        aircraftId: string,
        options: { follow?: boolean; adaptive?: boolean } = {}
    ): void {
        if (!this.map) return;

        const aircraft = this.stateManager.getAircraftById(aircraftId);
        if (!aircraft) {
            logger.warn('AircraftInteractionManager', 'Aircraft not found:', aircraftId);
            return;
        }

        const { lat, lon } = aircraft;
        const currentZoom = this.map.getZoom();
        const targetZoom = options.adaptive ? this.calculateAdaptiveZoom(currentZoom) : currentZoom;

        logger.debug('AircraftInteractionManager', `Flying to ${aircraftId} at ${lat.toFixed(2)}, ${lon.toFixed(2)}, zoom ${targetZoom.toFixed(1)}`);

        // Temporarily disable following during animation
        const wasFollowing = this.followingAircraft;
        this.followingAircraft = null;

        this.map.flyTo({
            center: [lon, lat],
            zoom: targetZoom,
            speed: 1.5,
            curve: 1.0,
            essential: true
        });

        // Start following after animation completes (if requested)
        if (options.follow) {
            this.map.once('moveend', () => {
                logger.debug('AircraftInteractionManager', 'FOLLOW STARTED:', aircraftId);
                this.followingAircraft = aircraftId;
            });
        }
    }

    /**
     * Zoom to aircraft with zoom-out-pan-zoom-in effect (for panel clicks)
     * @param aircraftId - Aircraft ID
     * @param enableFollow - Whether to enable follow mode after zoom
     */
    private zoomToAircraftWithEffect(aircraftId: string, enableFollow: boolean): void {
        if (!this.map) return;

        const aircraft = this.stateManager.getAircraftById(aircraftId);
        if (!aircraft) {
            logger.warn('AircraftInteractionManager', 'Aircraft not found:', aircraftId);
            return;
        }

        const { lat, lon } = aircraft;
        const currentZoom = this.map.getZoom();
        const targetZoom = this.calculateAdaptiveZoom(currentZoom);

        logger.debug('AircraftInteractionManager', `Zoom effect to ${aircraftId}: ${currentZoom.toFixed(1)} → ${targetZoom.toFixed(1)}`);

        // Temporarily disable following during animation
        this.followingAircraft = null;

        // Step 1: Zoom out slightly
        const zoomOutLevel = Math.max(currentZoom - 1, 4);
        this.map.easeTo({
            zoom: zoomOutLevel,
            duration: 200,
            essential: true
        });

        // Step 2: Pan to aircraft (after zoom out completes)
        setTimeout(() => {
            if (!this.map) return;

            this.map.flyTo({
                center: [lon, lat],
                zoom: zoomOutLevel,
                speed: 2.0,
                curve: 1.2,
                essential: true
            });

            // Step 3: Zoom in to target (after pan completes)
            this.map.once('moveend', () => {
                if (!this.map) return;

                this.map.easeTo({
                    zoom: targetZoom,
                    duration: 300,
                    essential: true
                });

                // Start following after all animations complete (if requested)
                if (enableFollow) {
                    this.map.once('moveend', () => {
                        logger.debug('AircraftInteractionManager', 'FOLLOW STARTED:', aircraftId);
                        this.followingAircraft = aircraftId;
                    });
                }
            });
        }, 200);
    }

    /**
     * Calculate adaptive zoom level based on current zoom
     * @param currentZoom - Current zoom level
     * @returns Target zoom level
     */
    private calculateAdaptiveZoom(currentZoom: number): number {
        if (currentZoom < 8) {
            return 9; // If zoomed out, zoom to moderate level
        } else {
            return Math.min(currentZoom + 2, 12); // If already zoomed in, zoom in a bit more
        }
    }

    /**
     * Start following an aircraft
     * @param aircraftId - Aircraft ID to follow
     */
    private startFollowing(aircraftId: string): void {
        logger.info('AircraftInteractionManager', '📍 Starting follow mode for:', aircraftId);
        this.followingAircraft = aircraftId;
    }

    /**
     * Stop following aircraft
     */
    private stopFollowing(): void {
        if (this.followingAircraft) {
            logger.info('AircraftInteractionManager', 'Stopping follow mode for:', this.followingAircraft);
            this.followingAircraft = null;
        }
    }

    /**
     * Update follow mode camera position
     * Called on each aircraft data update
     */
    public updateFollowing(aircraftData: AircraftData): void {
        // Only follow if we have a following aircraft and user isn't interacting
        if (!this.followingAircraft || this.isUserInteracting || !this.map) {
            return;
        }

        // Check if the aircraft we're following still exists
        if (!aircraftData.id || !aircraftData.id.includes(this.followingAircraft)) {
            logger.info('AircraftInteractionManager', '❌ Following aircraft no longer exists:', this.followingAircraft);
            this.stopFollowing();
            return;
        }

        // Get the current position of the aircraft we're following
        const aircraft = this.stateManager.getAircraftById(this.followingAircraft);
        if (!aircraft) {
            this.stopFollowing();
            return;
        }

        const { lat, lon } = aircraft;

        // Smoothly move camera to follow aircraft
        this.map.easeTo({
            center: [lon, lat],
            duration: 500, // Smooth 500ms animation
            essential: false // Allow user interruption
        });
    }

    /**
     * Request route data for an aircraft
     * @param aircraftId - Aircraft ID
     */
    private requestRouteData(aircraftId: string): void {
        // Track that we sent an explicit POS command
        // This helps distinguish user-initiated commands from unsolicited ROUTEDATA
        this.lastExplicitPosCommand = aircraftId;
        this.lastExplicitPosTime = Date.now();
        this.socketManager.sendCommand(`POS ${aircraftId}`);
    }

    /**
     * Check if we recently sent a POS command for this aircraft
     * Used to avoid treating server responses to our own commands as unsolicited data
     * @param aircraftId - Aircraft ID to check
     * @returns true if we recently sent POS for this aircraft
     */
    public wasLastExplicitPosFor(aircraftId: string): boolean {
        // Consider it an explicit POS if it was within the last 1 second
        return this.lastExplicitPosCommand === aircraftId &&
               (Date.now() - this.lastExplicitPosTime) < 1000;
    }

    /**
     * Get currently following aircraft ID
     */
    public getFollowingAircraft(): string | null {
        return this.followingAircraft;
    }

    /**
     * Check if in follow mode
     */
    public isFollowing(): boolean {
        return this.followingAircraft !== null;
    }

    /**
     * Cleanup resources
     */
    public destroy(): void {
        this.stopFollowing();
        // Event listeners are automatically cleaned up when map is destroyed
        logger.debug('AircraftInteractionManager', 'AircraftInteractionManager destroyed');
    }
}
