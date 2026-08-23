/**
 * AircraftInteractionManager - Handles aircraft selection and camera control
 *
 * Provides unified interaction behavior whether a click comes from the map
 * or from a panel (TrafficListPanel/ConflictsPanel emit document events):
 * single click toggles selection with a simple adaptive zoom, double click
 * selects with a zoom-out → pan → zoom-in effect and activates follow mode.
 * Clicking empty map, user drag, or the aircraft disappearing stops
 * following. Selection state itself is coordinated through StateManager.
 */

import { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import { MapDisplay } from '../MapDisplay';
import { StateManager } from '../../../core/StateManager';
import { SocketManager } from '../../../core/SocketManager';
import { AircraftData } from '../../../data/types';
import { logger } from '../../../utils/Logger';
import { ListenerRegistry } from '../../../utils/events';

export interface AircraftClickEvent {
    aircraftId: string;
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

    // Optional predicate reporting whether any map drawing tool (route,
    // shape, aircraft placement) is active - those clicks are point
    // placements, not aircraft deselects.
    private isDrawingToolActive: (() => boolean) | null = null;

    // Document-level listeners and state subscriptions, released in destroy()
    // (map listeners die with the map, but these would outlive it).
    private documentListeners = new ListenerRegistry();
    private stateUnsubscribers: (() => void)[] = [];

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
     * Query the aircraft layer at a point, guarding against the layer not
     * existing yet. The 'aircraft-points' layer is only created once aircraft
     * data has been rendered (i.e. when connected), and MapLibre throws if you
     * queryRenderedFeatures a layer that isn't in the style.
     */
    private queryAircraftAt(point: MapMouseEvent['point']) {
        if (!this.map || !this.map.getLayer('aircraft-points')) return [];
        return this.map.queryRenderedFeatures(point, { layers: ['aircraft-points'] });
    }

    /**
     * Set up map event handlers for aircraft clicks
     * Always sets up 2D layer handlers since 2D layer is always active
     */
    private setupMapEventHandlers(): void {
        if (!this.map) return;

        // Always set up 2D layer click handlers since the 2D layer is always active
        this.setup2DLayerHandlers();
        // Prevent default map zoom on aircraft double-click
        this.map.on('dblclick', (e: MapMouseEvent) => {
            if (!this.map) return;

            const features = this.queryAircraftAt(e.point);

            if (features.length > 0) {
                logger.verbose('AircraftInteractionManager', '🛑 Preventing default map zoom on aircraft double-click');
                e.preventDefault();
            }
        });

        // Click on empty map - unselect aircraft. The aircraft layer handlers
        // fire in this same synchronous dispatch, so the hit test must be
        // synchronous too: deferring it (the old 50ms setTimeout) let the
        // select-triggered flyTo or a data update move the aircraft off the
        // clicked point, misreading an aircraft click as an empty-map click
        // and instantly unselecting the aircraft that was just clicked.
        this.map.on('click', (e: MapMouseEvent) => {
            // With a drawing tool active, an empty-map click is a point
            // placement, not a request to unselect the aircraft.
            if (this.isDrawingToolActive && this.isDrawingToolActive()) {
                return;
            }

            if (this.queryAircraftAt(e.point).length > 0) return;

            logger.debug('AircraftInteractionManager', 'Empty map click - unselecting aircraft');
            const currentSelection = this.stateManager.getState().selectedAircraft;
            if (currentSelection) {
                // Send POS command to toggle route visibility off
                this.requestRouteData(currentSelection);
            }
            this.stopFollowing();
            this.stateManager.setSelectedAircraft(null);
        });

        // Stop following on user drag
        this.map.on('dragstart', () => {
            this.isUserInteracting = true;
            this.stopFollowing();
        });

        this.map.on('dragend', () => {
            this.isUserInteracting = false;
        });

        // Set up cursor changes for hover effects
        this.map.on('mouseenter', 'aircraft-points', () => {
            if (this.map) this.map.getCanvas().style.cursor = 'pointer';
        });

        this.map.on('mouseleave', 'aircraft-points', () => {
            if (this.map) this.map.getCanvas().style.cursor = '';
        });

        logger.debug('AircraftInteractionManager', 'Map event handlers set up for 2D aircraft layer');
    }

    /**
     * Set up click handlers specifically for 2D aircraft layer
     */
    private setup2DLayerHandlers(): void {
        if (!this.map) return;

        for (const [event, isDoubleClick] of [['click', false], ['dblclick', true]] as const) {
            this.map.on(event, 'aircraft-points', (e) => {
                const properties = e.features?.[0]?.properties;
                const aircraftId = properties?.entity_id || properties?.callsign;
                if (aircraftId) {
                    logger.debug('AircraftInteractionManager', `MAP 2D ${isDoubleClick ? 'DOUBLE' : 'SINGLE'} CLICK:`, aircraftId);
                    this.handleMapAircraftClick(aircraftId, isDoubleClick);
                }
            });
        }

        logger.debug('AircraftInteractionManager', '2D layer click handlers set up');
    }


    /**
     * Set up listeners for panel events
     */
    private setupPanelEventListeners(): void {
        // Panel clicks (TrafficListPanel, ConflictsPanel) get the same
        // behavior as map clicks: route data + zoom, follow on double click.
        this.documentListeners.add(document, 'aircraft-single-click', ((e: DocumentEventMap['aircraft-single-click']) => {
            const { aircraftId } = e.detail;
            logger.debug('AircraftInteractionManager', '📋 Panel single-click event received:', aircraftId);

            this.requestRouteData(aircraftId);
            this.zoomToAircraft(aircraftId, { follow: false, adaptive: true });
        }) as EventListener);

        this.documentListeners.add(document, 'aircraft-double-click', ((e: DocumentEventMap['aircraft-double-click']) => {
            const { aircraftId } = e.detail;
            logger.debug('AircraftInteractionManager', '📋 Panel double-click event received:', aircraftId);

            this.requestRouteData(aircraftId);
            this.zoomToAircraftWithEffect(aircraftId, true);
        }) as EventListener);

        // Panel unselect mirrors the map's unselect path: toggle the route
        // broadcast off and stop following the aircraft.
        this.documentListeners.add(document, 'aircraft-unselect', ((e: DocumentEventMap['aircraft-unselect']) => {
            const { aircraftId } = e.detail;
            logger.debug('AircraftInteractionManager', '📋 Panel unselect event received:', aircraftId);

            this.requestRouteData(aircraftId);
            this.stopFollowing();
        }) as EventListener);

        logger.debug('AircraftInteractionManager', 'Panel event listeners set up');
    }

    /**
     * Set up subscriptions to state changes
     */
    private setupStateSubscriptions(): void {
        // Follow mode tracks each aircraft data update
        this.stateUnsubscribers.push(this.stateManager.subscribe('aircraftData', (newData) => {
            if (newData) {
                this.updateFollowing(newData);
            }
        }));

        // When selection switches directly from one aircraft to another
        // (map or panel click - no unselect step in between), toggle the
        // old aircraft's route broadcast off. Otherwise it keeps streaming
        // ROUTEDATA, which wastes bandwidth and used to get re-interpreted
        // as an "implicit selection" that stole the new selection back.
        this.stateUnsubscribers.push(this.stateManager.subscribe('selectedAircraft', (newAircraft, oldAircraft) => {
            if (oldAircraft && newAircraft && oldAircraft !== newAircraft) {
                this.requestRouteData(oldAircraft);
            }
        }));

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
            // Double click: select + fancy zoom effect + follow
            logger.debug('AircraftInteractionManager', '🚀 Map double-click: selecting and following', aircraftId);

            this.stateManager.setSelectedAircraft(aircraftId);
            this.requestRouteData(aircraftId);
            this.zoomToAircraftWithEffect(aircraftId, true);

        } else if (isCurrentlySelected) {
            // Single click on selected aircraft: POS toggles the route
            // visibility off, then clear selection and stop following.
            logger.debug('AircraftInteractionManager', '🔄 Map single-click: unselecting', aircraftId);
            this.requestRouteData(aircraftId);
            this.stateManager.setSelectedAircraft(null);
            this.stopFollowing();
        } else {
            // Single click on a new aircraft: select with simple zoom
            logger.debug('AircraftInteractionManager', 'Map single-click: selecting', aircraftId);
            this.stateManager.setSelectedAircraft(aircraftId);
            this.requestRouteData(aircraftId);
            this.zoomToAircraft(aircraftId, { follow: false, adaptive: true });
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
     * Register a predicate that reports whether any interactive drawing tool
     * (route, shape, aircraft placement) is in progress. When true, empty-map
     * clicks are suppressed from the "unselect aircraft" path so they can be
     * consumed as point drops.
     */
    public setDrawingToolActiveCheck(check: () => boolean): void {
        this.isDrawingToolActive = check;
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
     * Cleanup resources. Map listeners die with the map; the document
     * listeners and state subscription must be released explicitly.
     */
    public destroy(): void {
        this.stopFollowing();
        this.documentListeners.removeAll();
        this.stateUnsubscribers.forEach(unsub => unsub());
        this.stateUnsubscribers = [];
        logger.debug('AircraftInteractionManager', 'AircraftInteractionManager destroyed');
    }
}
