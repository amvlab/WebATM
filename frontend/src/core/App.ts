import { AircraftData, RouteData, AppState } from '../data/types';
import { SocketManager } from './SocketManager';
import { StateManager } from './StateManager';
import { connectionStatus } from './ConnectionStatusService';
import { Console } from '../ui/Console';
import { Controls } from '../ui/Controls';
import { Header } from '../ui/Header';
import { settingsModal } from '../ui/SettingsModal';
import { serverManager } from '../ui/ServerManager';
import { modals } from '../ui/Modals';
import { modalManager } from '../ui/ModalManager';
import { panelResizer } from '../ui/panels/PanelResizer';
import { SimulationNodesPanel } from '../ui/panels/left/SimulationNodesPanel';
import { MapControlsPanel } from '../ui/panels/left/MapControlsPanel';
import { DisplayOptionsPanel } from '../ui/panels/left/DisplayOptionsPanel';
import { TrafficListPanel } from '../ui/panels/right/TrafficListPanel';
import { AircraftInfoPanel } from '../ui/panels/right/AircraftInfoPanel';
import { ConflictsPanel } from '../ui/panels/right/ConflictsPanel';
import { CommandPaletteModal } from '../ui/CommandPaletteModal';
import { echoManager } from '../ui/EchoManager';
import { MapDisplay } from '../ui/map/MapDisplay';
import { MapOverlay } from '../ui/map/MapOverlay';
import { ShapeDrawingManager } from '../ui/map/shapes/ShapeDrawingManager';
import { ShapeRenderer } from '../ui/map/shapes/ShapeRenderer';
import { NavdataRenderer } from '../ui/map/navdata/NavdataRenderer';
import { NavaidSnapper } from '../ui/map/navdata/NavaidSnapper';
import { NavSearchBox } from '../ui/map/navdata/NavSearchBox';
import { AircraftCreationManager } from '../ui/map/aircraft/AircraftCreationManager';
import { AircraftInteractionManager } from '../ui/map/aircraft/AircraftInteractionManager';
import { RouteDrawingManager } from '../ui/map/routes/RouteDrawingManager';
import { CommandHandler } from '../data/CommandHandler';
import { logger } from '../utils/Logger';

/**
 * Main application coordinator: creates the core modules and UI components,
 * wires them together, and manages the overall application lifecycle.
 */
export class App {
    private socketManager: SocketManager;
    private stateManager: StateManager;
    private console: Console;
    private controls: Controls;
    private header: Header;
    private simulationNodesPanel: SimulationNodesPanel;
    private mapControlsPanel: MapControlsPanel;
    private displayOptionsPanel: DisplayOptionsPanel;
    private trafficListPanel: TrafficListPanel;
    private aircraftInfoPanel: AircraftInfoPanel;
    private conflictsPanel: ConflictsPanel;
    private commandPaletteModal: CommandPaletteModal;
    private mapDisplay: MapDisplay;
    private mapOverlay: MapOverlay | null = null;
    private shapeDrawingManager: ShapeDrawingManager | null = null;
    private shapeRenderer: ShapeRenderer | null = null;
    private navdataRenderer: NavdataRenderer | null = null;
    private navaidSnapper: NavaidSnapper;
    private navSearchBox: NavSearchBox | null = null;
    private aircraftCreationManager: AircraftCreationManager | null = null;
    private aircraftInteractionManager: AircraftInteractionManager | null = null;
    private routeDrawingManager: RouteDrawingManager | null = null;
    private commandHandler: CommandHandler;
    private initialized: boolean = false;
    // Aborting removes the global document/window listeners registered in
    // setupGlobalEventListeners.
    private globalListenerAbort = new AbortController();

    constructor() {
        this.stateManager = new StateManager();
        this.socketManager = new SocketManager(this.stateManager);
        this.console = new Console();
        this.controls = new Controls(this.stateManager);
        this.header = new Header();
        this.simulationNodesPanel = new SimulationNodesPanel();
        this.mapControlsPanel = new MapControlsPanel();
        this.displayOptionsPanel = new DisplayOptionsPanel();
        this.trafficListPanel = new TrafficListPanel();
        this.aircraftInfoPanel = new AircraftInfoPanel();
        this.conflictsPanel = new ConflictsPanel();
        this.commandPaletteModal = new CommandPaletteModal();
        this.mapDisplay = new MapDisplay('map');
        this.commandHandler = new CommandHandler(this);
        // Shared "snap to navaid" helper used by the drawing/creation tools and
        // the console map-picker. The NavdataRenderer is created later (on
        // style.load), so resolve its airport-rank threshold lazily.
        this.navaidSnapper = new NavaidSnapper(
            this.mapDisplay,
            this.stateManager,
            (zoom) => this.navdataRenderer?.minAirportRankForZoom(zoom) ?? 0
        );
    }

    /**
     * Initialize the application
     * Sets up all modules and starts the application lifecycle
     */
    public async initialize(): Promise<void> {
        if (this.initialized) {
            logger.warn('App', 'App already initialized');
            return;
        }

        try {
            logger.info('App', 'Initializing BlueSky Web Client...');

            this.initializeState();
            await this.socketManager.initialize();
            this.controls.setSocketManager(this.socketManager);
            serverManager.setSocket(this.socketManager.getSocket());
            this.initializeUI();
            this.setupGlobalEventListeners();

            this.initialized = true;
            logger.info('App', 'BlueSky Web Client initialized successfully');
            echoManager.success('WebATM initialized');

        } catch (error) {
            logger.error('App', 'Failed to initialize application:', error);
            throw error;
        }
    }

    /**
     * Initialize application state
     */
    private initializeState(): void {
        this.setupConnectionStatusHandlers();
        this.setupSimulationDataHandlers();
    }

    /**
     * Set up handlers for connection status changes
     */
    private setupConnectionStatusHandlers(): void {
        // ConnectionStatusService is the single source of truth for all
        // connection state.
        connectionStatus.subscribe(() => {
            this.updateConnectionStatusDisplay();
        });

        // Register callback for BlueSky disconnect to clean up visual elements
        connectionStatus.onBlueSkyDisconnect(() => {
            this.clearAllVisualElements();
        });

        // Note: We do NOT auto-open settings modal on disconnection events.
        // The settings modal is only auto-opened on initial page load if not connected
        // (handled in checkInitialConnectionStatus method).
    }

    /**
     * Set up handlers for simulation data changes
     */
    private setupSimulationDataHandlers(): void {
        // Header shows simulation time, rate, etc.
        this.stateManager.subscribe('simInfo', (newSimInfo) => {
            if (newSimInfo) {
                this.header.updateSimInfo(newSimInfo);
            }
        });

        this.stateManager.subscribe('aircraftData', (newAircraftData) => {
            if (newAircraftData && this.mapOverlay) {
                this.mapOverlay.updateFromAircraftData(newAircraftData);
            }
        });

        this.stateManager.subscribe('displayOptions', (newOptions) => {
            if (newOptions && this.mapOverlay) {
                this.mapOverlay.updateDisplayOptions(newOptions);
            }
            // Toggle the airport/waypoint search bar visibility
            if (newOptions) {
                this.navSearchBox?.setVisible(newOptions.showSearchBar);
            }
        });

        this.stateManager.subscribe('selectedAircraft', (newSelected) => {
            if (this.mapOverlay) {
                this.mapOverlay.setSelectedAircraft(newSelected);
            }
        });
    }

    /**
     * Update connection status display using ConnectionStatusService
     * This is the single method that updates UI based on connection state
     */
    private updateConnectionStatusDisplay(): void {
        const status = connectionStatus.getStatus();

        this.header.setControlsEnabled(status.blueSkyConnected);
        this.header.updateConnectionStatus(connectionStatus.getStatusString());

        logger.debug('App', 'Connection status update:', {
            webSocket: status.webSocketConnected,
            blueSky: status.blueSkyConnected,
            receiving: status.receivingData,
            lastNodeInfo: status.lastNodeInfoReceived ?
                `${Date.now() - status.lastNodeInfoReceived}ms ago` : 'never'
        });
    }

    /**
     * Initialize UI components
     * Sets up UI modules and their event handlers
     */
    private initializeUI(): void {
        this.initializeHeader();
        this.initializeConsole();
        this.initializeControlPanels();
        this.initializeMapDisplay();
        this.initializeModals();

        // Update UI based on initial state
        this.updateUI();

        // Check if we need to show settings on initial load
        this.checkInitialConnectionStatus();
    }

    /**
     * Check initial connection status and open settings if not connected
     * This should only run once on initial page load
     * Delegates to ConnectionStatusService for centralized logic
     */
    private checkInitialConnectionStatus(): void {
        // The integrated build auto-starts BlueSky and auto-connects on boot
        // (and hides the connect controls in Settings), so don't pop Settings
        // open while that auto-connect is still settling. Only the standalone
        // build, where the user must connect manually, prompts on load.
        if (INTEGRATED_BUILD) {
            return;
        }

        connectionStatus.startInitialConnectionCheck(() => {
            logger.info('App', 'Initial load: Not connected - opening settings modal');
            settingsModal.open();
        });
    }

    /**
     * Initialize header component
     */
    private initializeHeader(): void {
        this.header.init();
        this.header.setSocketManager(this.socketManager);
        this.header.setStateManager(this.stateManager);
        logger.debug('App', 'Header initialized');
    }

    /**
     * Initialize console component
     */
    private initializeConsole(): void {
        this.console.setStateManager(this.stateManager);
        this.console.setCommandHandler(this.commandHandler);
        // Map display enables map-click coordinate/heading insertion when
        // typing lat/lon/hdg arguments.
        this.console.setMapDisplay(this.mapDisplay, this.navaidSnapper);
        logger.debug('App', 'Console component initialized');
    }

    /**
     * Initialize control panels
     */
    private initializeControlPanels(): void {
        this.controls.init();

        this.simulationNodesPanel.init();
        this.simulationNodesPanel.setSocketManager(this.socketManager);

        this.mapControlsPanel.init();
        this.mapControlsPanel.setMapDisplay(this.mapDisplay);

        this.displayOptionsPanel.init();
        this.displayOptionsPanel.setStateManager(this.stateManager);
        this.displayOptionsPanel.setApp(this);

        // Command palette: opened by the Ctrl/Cmd+K shortcut (registered in
        // setupGlobalEventListeners) and the "Commands" button in the console
        // header.
        this.commandPaletteModal.setStateManager(this.stateManager);
        this.commandPaletteModal.setConsole(this.console);
        const openPaletteBtn = document.getElementById('open-command-palette');
        if (openPaletteBtn) {
            openPaletteBtn.addEventListener('click', () => {
                this.commandPaletteModal.open();
            });
        }

        this.trafficListPanel.init();
        this.trafficListPanel.setStateManager(this.stateManager);

        this.aircraftInfoPanel.init();
        this.aircraftInfoPanel.setStateManager(this.stateManager);

        this.conflictsPanel.init();
        this.conflictsPanel.setStateManager(this.stateManager);

        this.verifyElementExists('play-btn', 'Play button');
        this.verifyElementExists('settings-btn', 'Settings button');

        logger.debug('App', 'Control panels initialized');
    }

    private verifyElementExists(id: string, label: string): HTMLElement | null {
        const el = document.getElementById(id);
        if (el) {
            logger.verbose('App', `${label} found`);
        } else {
            logger.warn('App', `✗ ${label} not found`);
        }
        return el;
    }

    /**
     * Initialize map display
     */
    private initializeMapDisplay(): void {
        this.mapDisplay.initialize();
        this.mapDisplay.setupStyleSelector();

        // The renderers below must be created only after the map style has
        // loaded, or MapLibre throws "Style is not done loading".
        this.mapDisplay.setMapLoadCallback(async () => {
            this.mapControlsPanel.setupMapEventListeners();

            this.shapeRenderer = new ShapeRenderer(this.mapDisplay, this.stateManager);
            this.shapeRenderer.initialize();

            // Navdata overlay (airports + waypoints vector tiles). Done before
            // the aircraft overlay so aircraft draw on top.
            this.navdataRenderer = new NavdataRenderer(this.mapDisplay, this.stateManager);
            this.navdataRenderer.initialize();

            this.mapOverlay = new MapOverlay(this.mapDisplay, this.stateManager);
            const displayOptions = this.stateManager.getState().displayOptions;
            await this.mapOverlay.initialize(displayOptions);
            logger.debug('App', 'Map renderers initialized after map style loaded');

            // Replay any aircraft data/selection that arrived before the map
            // was ready.
            const currentState = this.stateManager.getState();
            if (currentState.aircraftData && currentState.aircraftData.id.length > 0) {
                this.mapOverlay.updateFromAircraftData(currentState.aircraftData);
            }
            if (currentState.selectedAircraft) {
                this.mapOverlay.setSelectedAircraft(currentState.selectedAircraft);
            }
        });

        this.mapDisplay.onStyleChange(() => {
            this.mapOverlay?.onStyleChange();
            this.shapeRenderer?.onStyleChange();
            this.navdataRenderer?.onStyleChange();

            // Re-emit the display options so all renderers re-render after the
            // style swap; requestAnimationFrame lets the layers finish setting
            // up first.
            requestAnimationFrame(() => {
                const currentOptions = this.stateManager.getDisplayOptions();
                this.stateManager.updateDisplayOptions({...currentOptions});
            });
        });

        this.shapeDrawingManager = new ShapeDrawingManager(this.mapDisplay, this, this.navaidSnapper);
        this.aircraftCreationManager = new AircraftCreationManager(this.mapDisplay, this.navaidSnapper);
        this.aircraftInteractionManager = new AircraftInteractionManager(
            this.mapDisplay,
            this.stateManager,
            this.socketManager
        );
        this.routeDrawingManager = new RouteDrawingManager(
            this.mapDisplay,
            this,
            this.stateManager,
            this.navaidSnapper
        );

        // Let AircraftInteractionManager know when route drawing is active so
        // it can skip its empty-map-click "unselect aircraft" behavior while
        // waypoints are being placed.
        if (this.aircraftInteractionManager && this.routeDrawingManager) {
            const rdm = this.routeDrawingManager;
            this.aircraftInteractionManager.setRouteDrawingActiveCheck(
                () => rdm.isDrawing()
            );
        }

        // Must come after AircraftInteractionManager creation so the handler
        // can check for explicit POS commands.
        this.setupRouteDataHandler();

        // Airport/waypoint "go to" search box, applying the saved show/hide
        // preference.
        this.navSearchBox = new NavSearchBox(this.mapDisplay);
        this.navSearchBox.init();
        this.navSearchBox.setVisible(this.stateManager.getDisplayOptions().showSearchBar);

        this.mapControlsPanel.setShapeDrawingManager(this.shapeDrawingManager);
        this.mapControlsPanel.setAircraftCreationManager(this.aircraftCreationManager);
        this.mapControlsPanel.setRouteDrawingManager(this.routeDrawingManager);

        logger.debug('App', 'Map display and interaction managers initialized');
    }

    /**
     * Initialize modal dialogs
     */
    private initializeModals(): void {
        modals.forceInitialize();
        logger.debug('App', 'Modal system initialized');
    }

    /**
     * Set up global event listeners
     */
    private setupGlobalEventListeners(): void {
        const { signal } = this.globalListenerAbort;

        // Handle before page unload
        window.addEventListener('beforeunload', () => {
            this.cleanup();
        }, { signal });

        // Handle resize events
        window.addEventListener('resize', () => {
            this.handleResize();
        }, { signal });

        // Command palette shortcut. Bind Ctrl/Cmd+K and Ctrl/Cmd+Shift+P
        // (VS Code muscle memory). We avoid plain Ctrl+P because that's the
        // browser print shortcut. The shortcut fires regardless of focus -
        // the most common case is "I'm typing in the console, what was that
        // command called again?" so blocking it while the input has focus
        // would defeat the purpose.
        document.addEventListener('keydown', (e: KeyboardEvent) => {
            const cmdOrCtrl = e.ctrlKey || e.metaKey;
            if (!cmdOrCtrl) return;
            const key = e.key.toLowerCase();
            const isPaletteShortcut =
                key === 'k' || (e.shiftKey && key === 'p');
            if (!isPaletteShortcut) return;
            e.preventDefault();
            this.commandPaletteModal.open();
        }, { signal });
    }

    /**
     * Set up route data handler
     * Called after AircraftInteractionManager is initialized
     * so we can check if ROUTEDATA is a response to an explicit POS command
     */
    private setupRouteDataHandler(): void {
        this.socketManager.setEventHandlers({
            onRouteData: (data: RouteData) => {
                // Check if we just sent an explicit POS command for this aircraft
                const isExplicitPosResponse = this.aircraftInteractionManager?.wasLastExplicitPosFor(data.acid) ?? false;

                // If receiving ROUTEDATA for an aircraft that is not currently selected,
                // treat it as an implicit selection ONLY if it's not a response to our explicit POS
                const currentSelection = this.stateManager.getState().selectedAircraft;
                if (data.acid && data.acid !== currentSelection && !isExplicitPosResponse) {
                    logger.info('App', '🛰️ Unsolicited ROUTEDATA received for', data.acid, '- treating as implicit selection');
                    this.stateManager.setSelectedAircraft(data.acid);
                }

                if (this.mapOverlay) {
                    this.mapOverlay.updateRouteData(data);
                }
            },
            onReset: () => {
                // Clear 3D aircraft models BEFORE the state reset.
                this.mapOverlay?.reset();

                // This handler overrides SocketManager's built-in onReset, so
                // the state reset it normally performs must happen here.
                this.stateManager.reset();
                logger.info('App', 'Simulation reset - connection maintained');
            }
        });
    }

    /**
     * Handle window resize
     */
    private handleResize(): void {
        if (this.mapDisplay && this.mapDisplay.isInitialized()) {
            this.mapDisplay.resize();
        }
    }

    /**
     * Update UI based on current state (initial call after init).
     */
    private updateUI(): void {
        const state = this.stateManager.getState();

        this.updateConnectionStatusDisplay();

        if (state.simInfo) {
            this.header.updateSimInfo(state.simInfo);
        }
    }

    /**
     * Send command to simulation
     */
    public sendCommand(command: string): Promise<boolean> {
        return this.socketManager.sendCommand(command);
    }

    /**
     * Get the current route data for the selected aircraft (if any).
     * Used by RouteDrawingManager to anchor a leader line from the last
     * existing waypoint when appending to an aircraft that already has a route.
     */
    public getRouteData(): RouteData | null {
        return this.mapOverlay ? this.mapOverlay.getRouteData() : null;
    }

    /**
     * Get the AircraftInteractionManager instance (may be null if not yet
     * initialized). Used by RouteDrawingManager to route its trailing POS
     * command through the manager's explicit-POS tracking path so the
     * resulting ROUTEDATA response is not misclassified as unsolicited.
     */
    public getAircraftInteractionManager(): AircraftInteractionManager | null {
        return this.aircraftInteractionManager;
    }

    /**
     * Set active simulation node
     */
    public setActiveNode(nodeId: string): void {
        this.socketManager.setActiveNode(nodeId);
        this.stateManager.setActiveNode(nodeId);
    }

    public getState(): AppState {
        return this.stateManager.getState();
    }

    public getSocketManager(): SocketManager {
        return this.socketManager;
    }

    public getStateManager(): StateManager {
        return this.stateManager;
    }

    public getConsole(): Console {
        return this.console;
    }

    public getMapDisplay(): MapDisplay {
        return this.mapDisplay;
    }

    public getMapOverlay(): MapOverlay | null {
        return this.mapOverlay;
    }

    public getMapControlsPanel(): MapControlsPanel {
        return this.mapControlsPanel;
    }

    public getDisplayOptionsPanel(): DisplayOptionsPanel {
        return this.displayOptionsPanel;
    }

    /**
     * Clear all visual elements from the display
     * Called when transitioning from connected to disconnected state
     * Removes: aircraft, shapes, routes, trails, and protected zones
     */
    private clearAllVisualElements(): void {
        logger.info('App', 'Clearing all visual elements (aircraft, shapes, routes, trails, protected zones)');

        // Push an empty aircraft update so the overlay removes the markers -
        // no further data will arrive to do it once disconnected.
        if (this.mapOverlay) {
            const emptyAircraftData: AircraftData = {
                id: [],
                lat: [],
                lon: [],
                alt: [],
                trk: [],
                vs: [],
                tas: [],
                actype: [],
                inconf: [],
                tcpamax: [],
                nconf_cur: 0,
                nconf_tot: 0,
                nlos_cur: 0,
                nlos_tot: 0
            };
            this.mapOverlay.updateFromAircraftData(emptyAircraftData);
        }

        this.mapOverlay?.clearRouteDisplay();

        // Clears simInfo, aircraftData, selectedAircraft, activeNode, shapes.
        this.stateManager.reset();
    }

    /**
     * Clean up resources before page unload
     */
    private cleanup(): void {
        logger.info('App', 'Cleaning up application resources');

        this.socketManager.disconnect();
        this.header.destroy();
        this.controls.destroy();

        // Panels
        this.simulationNodesPanel.destroy();
        this.mapControlsPanel.destroy();
        this.displayOptionsPanel.destroy();
        this.trafficListPanel.destroy();
        this.aircraftInfoPanel.destroy();
        this.conflictsPanel.destroy();
        panelResizer.destroy();

        // Modals and their document-level listeners
        this.commandPaletteModal.destroy();
        modalManager.destroy();

        // Map renderers and interaction/drawing managers (created lazily,
        // so they may still be null here)
        this.mapOverlay?.destroy();
        this.shapeRenderer?.destroy();
        this.navdataRenderer?.destroy();
        this.aircraftInteractionManager?.destroy();
        this.aircraftCreationManager?.destroy();
        this.shapeDrawingManager?.destroy();
        this.routeDrawingManager?.destroy();
        this.mapDisplay.destroy();

        // Remove the global listeners registered in setupGlobalEventListeners
        this.globalListenerAbort.abort();
    }
}