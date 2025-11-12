import { SimInfo, AircraftData, RouteData, NodeInfo, AppState, InitialData } from '../data/types';
import { SocketManager } from './SocketManager';
import { StateManager } from './StateManager';
import { connectionStatus } from './ConnectionStatusService';
import { Console } from '../ui/Console';
import { Controls } from '../ui/Controls';
import { Header } from '../ui/Header';
import { settingsModal } from '../ui/SettingsModal';
import { serverManager } from '../ui/ServerManager';
import { modals } from '../ui/Modals';
import { panelResizer } from '../ui/panels/PanelResizer';
import { SimulationNodesPanel } from '../ui/panels/left/SimulationNodesPanel';
import { MapControlsPanel } from '../ui/panels/left/MapControlsPanel';
import { DisplayOptionsPanel } from '../ui/panels/left/DisplayOptionsPanel';
import { TrafficListPanel } from '../ui/panels/right/TrafficListPanel';
import { AircraftInfoPanel } from '../ui/panels/right/AircraftInfoPanel';
import { ConflictsPanel } from '../ui/panels/right/ConflictsPanel';
import { storage } from '../utils/StorageManager';
import { echoManager } from '../ui/EchoManager';
import { MapDisplay } from '../ui/map/MapDisplay';
import { MapOverlay } from '../ui/map/MapOverlay';
import { ShapeDrawingManager } from '../ui/map/shapes/ShapeDrawingManager';
import { ShapeRenderer } from '../ui/map/shapes/ShapeRenderer';
import { AircraftCreationManager } from '../ui/map/aircraft/AircraftCreationManager';
import { AircraftInteractionManager } from '../ui/map/aircraft/AircraftInteractionManager';
import { CommandHandler } from '../data/CommandHandler';
import { logger } from '../utils/Logger';

/**
 * Main application coordinator for the BlueSky Web Client
 * 
 * This class serves as the central hub for the TypeScript web application,
 * coordinating between different modules and managing the overall application lifecycle.
 * It replaces the BlueSkyWebUI class from app.js with a more modular TypeScript architecture.
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
    private mapDisplay: MapDisplay;
    private mapOverlay: MapOverlay | null = null;
    private shapeDrawingManager: ShapeDrawingManager | null = null;
    private shapeRenderer: ShapeRenderer | null = null;
    private aircraftCreationManager: AircraftCreationManager | null = null;
    private aircraftInteractionManager: AircraftInteractionManager | null = null;
    private commandHandler: CommandHandler;
    private initialized: boolean = false;

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
        this.mapDisplay = new MapDisplay('map');
        this.commandHandler = new CommandHandler(this);
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

            // Initialize state management
            this.initializeState();

            // Initialize socket connections
            await this.socketManager.initialize();
            
            // Connect controls to socket manager
            this.controls.setSocketManager(this.socketManager);
            
            // Connect server manager to socket
            serverManager.setSocket(this.socketManager.getSocket());

            // Initialize UI components
            this.initializeUI();

            // Set up global event listeners
            this.setupGlobalEventListeners();

            this.initialized = true;
            logger.info('App', 'BlueSky Web Client initialized successfully');

            // Add initialization message to echo
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
        // StateManager already initializes with default values,
        // so we just need to ensure it's ready
        // The default state is already set in StateManager constructor
        logger.debug('App', 'State manager initialized with default state');

        // Subscribe to connection state changes
        this.setupConnectionStatusHandlers();

        // Subscribe to simulation data changes
        this.setupSimulationDataHandlers();
    }

    /**
     * Set up handlers for connection status changes
     */
    private setupConnectionStatusHandlers(): void {
        // Subscribe to ConnectionStatusService for centralized status updates
        // This is the single source of truth for all connection state
        connectionStatus.subscribe((status) => {
            // Update UI based on centralized connection status
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
        // Subscribe to simInfo updates from StateManager
        this.stateManager.subscribe('simInfo', (newSimInfo, oldSimInfo) => {
            if (newSimInfo) {
                // Update header with new simulation info (time, rate, etc.)
                this.header.updateSimInfo(newSimInfo);
            }
        });

        // Subscribe to aircraft data updates
        this.stateManager.subscribe('aircraftData', (newAircraftData, oldAircraftData) => {
            if (newAircraftData) {
                // Update aircraft display
                this.updateAircraftDisplay(newAircraftData);

                // Update map overlay with aircraft data
                if (this.mapOverlay) {
                    this.mapOverlay.updateFromAircraftData(newAircraftData);
                }
            }
        });

        // Subscribe to display options changes
        this.stateManager.subscribe('displayOptions', (newOptions, oldOptions) => {
            if (newOptions && this.mapOverlay) {
                // Update map overlay with new display options
                this.mapOverlay.updateDisplayOptions(newOptions);
            }
        });

        // Subscribe to selected aircraft changes
        this.stateManager.subscribe('selectedAircraft', (newSelected, oldSelected) => {
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

        // Enable/disable controls based on connection
        this.header.setControlsEnabled(status.blueSkyConnected);

        // Get status string from ConnectionStatusService (single source of truth)
        const statusString = connectionStatus.getStatusString();
        this.header.updateConnectionStatus(statusString);

        // Log detailed status for debugging when connection state changes
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
        // Initialize header
        this.initializeHeader();

        // Initialize console
        this.initializeConsole();

        // Initialize control panels
        this.initializeControlPanels();

        // Initialize panel resizing
        this.initializePanelResizing();

        // Initialize map display
        this.initializeMapDisplay();

        // Initialize modal dialogs
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
        // Use ConnectionStatusService to handle initial connection checking
        connectionStatus.startInitialConnectionCheck(() => {
            // Callback when not connected after initial check
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
        // Console is already instantiated in constructor and will set up event listeners
        // Set state manager reference for accessing cmddict
        this.console.setStateManager(this.stateManager);
        // Set command handler reference for processing local commands
        this.console.setCommandHandler(this.commandHandler);
        logger.debug('App', 'Console component initialized');
    }

    /**
     * Initialize control panels
     */
    private initializeControlPanels(): void {
        // Initialize Controls - must be called after DOM is ready
        this.controls.init();
        logger.debug('App', 'Control panels initialized - Controls instance ready');

        // Initialize Simulation Nodes Panel
        this.simulationNodesPanel.init();
        this.simulationNodesPanel.setSocketManager(this.socketManager);
        logger.debug('App', 'SimulationNodesPanel initialized');

        // Initialize Map Controls Panel
        this.mapControlsPanel.init();
        this.mapControlsPanel.setMapDisplay(this.mapDisplay);
        logger.debug('App', 'MapControlsPanel initialized');

        // Initialize Display Options Panel
        this.displayOptionsPanel.init();
        this.displayOptionsPanel.setStateManager(this.stateManager);
        logger.debug('App', 'DisplayOptionsPanel initialized');

        // Initialize Traffic List Panel
        this.trafficListPanel.init();
        this.trafficListPanel.setStateManager(this.stateManager);
        logger.debug('App', 'TrafficListPanel initialized');

        // Initialize Aircraft Info Panel
        this.aircraftInfoPanel.init();
        this.aircraftInfoPanel.setStateManager(this.stateManager);
        logger.debug('App', 'AircraftInfoPanel initialized');

        // Initialize Conflicts Panel
        this.conflictsPanel.init();
        this.conflictsPanel.setStateManager(this.stateManager);
        logger.debug('App', 'ConflictsPanel initialized');

        // Verify controls are working by checking if key elements exist
        const playBtn = document.getElementById('play-btn');
        const settingsBtn = document.getElementById('settings-btn');
        const menuDropdownBtn = document.getElementById('menu-dropdown-btn');

        if (playBtn) {
            logger.verbose('App', 'Play button found');
        } else {
            logger.warn('App', '✗ Play button not found');
        }

        if (settingsBtn) {
            logger.verbose('App', 'Settings button found');
        } else {
            logger.warn('App', '✗ Settings button not found');
        }

        if (menuDropdownBtn) {
            logger.verbose('App', 'Menu dropdown button found');
        } else {
            logger.warn('App', '✗ Menu dropdown button not found');
        }

        logger.debug('App', 'Controls event handlers should be active');
    }

    /**
     * Initialize panel resizing
     */
    private initializePanelResizing(): void {
        // Panel resizer is already instantiated as a singleton
        // Set up the reset layout button handler
        const resetButton = document.getElementById('reset-layout-btn');
        if (resetButton) {
            resetButton.addEventListener('click', () => {
                panelResizer.resetToDefaults();
                logger.info('App', 'Panel layout reset to defaults');

                // Also reset font sizes to defaults
                this.resetFontSizesToDefaults();
            });
            logger.debug('App', 'Reset layout button handler attached');
        } else {
            logger.warn('App', '✗ Reset layout button not found');
        }

        logger.debug('App', 'Panel resizing initialized');
    }

    /**
     * Reset all font sizes to default values
     */
    private resetFontSizesToDefaults(): void {
        const defaultFontSize = 11; // Default font size in pixels

        // Clear font size values from storage using StorageManager
        storage.remove('console-font-size');
        storage.remove('panel-font-size');

        // Update state manager with default font sizes
        this.stateManager.updateDisplayOptions({
            consoleFontSize: defaultFontSize,  // Applies to both console and echo
            panelFontSize: defaultFontSize
        });

        // Apply CSS variables directly
        document.documentElement.style.setProperty('--console-font-size', `${defaultFontSize}px`);
        document.documentElement.style.setProperty('--echo-font-size', `${defaultFontSize}px`);
        document.documentElement.style.setProperty('--console-input-font-size', `${defaultFontSize}px`);
        document.documentElement.style.setProperty('--panel-font-size', `${defaultFontSize}px`);

        // Update the UI controls in DisplayOptionsPanel to reflect the reset values
        this.updateFontSizeUIControls('console-font-size', 'console-font-size-value', defaultFontSize);
        this.updateFontSizeUIControls('panel-font-size', 'panel-font-size-value', defaultFontSize);

        logger.info('App', 'Font sizes reset to defaults:', defaultFontSize);
    }

    /**
     * Update font size UI controls (slider and display value)
     */
    private updateFontSizeUIControls(inputId: string, valueId: string, size: number): void {
        const input = document.getElementById(inputId) as HTMLInputElement;
        if (input) input.value = size.toString();

        const valueSpan = document.getElementById(valueId);
        if (valueSpan) valueSpan.textContent = size.toString();
    }

    /**
     * Initialize map display
     */
    private initializeMapDisplay(): void {
        // Initialize the MapLibre GL map
        this.mapDisplay.initialize();

        // Set up the map style selector (connects to settings modal)
        this.mapDisplay.setupStyleSelector();

        // Set up callback for when map finishes loading
        // This ensures MapControlsPanel event listeners are attached AFTER the map is ready
        this.mapDisplay.setMapLoadCallback(() => {
            logger.debug('App', 'Map loaded - setting up MapControlsPanel event listeners');
            this.mapControlsPanel.setupMapEventListeners();

            // Initialize shape renderer AFTER map style is loaded
            // This prevents "Style is not done loading" errors
            this.shapeRenderer = new ShapeRenderer(this.mapDisplay, this.stateManager);
            this.shapeRenderer.initialize();
            logger.debug('App', 'Shape renderer initialized after map style loaded');

            // Initialize the map overlay with display options AFTER map style is loaded
            // This prevents "Style is not done loading" errors for aircraft routes
            this.mapOverlay = new MapOverlay(this.mapDisplay, this.stateManager);
            const displayOptions = this.stateManager.getState().displayOptions;
            this.mapOverlay.initialize(displayOptions);
            logger.debug('App', 'Map overlay initialized after map style loaded');

            // Update overlay with any aircraft data that arrived before map was ready
            const currentState = this.stateManager.getState();
            if (currentState.aircraftData && currentState.aircraftData.id.length > 0) {
                logger.debug('App', 'Updating map overlay with existing aircraft data:', currentState.aircraftData.id.length, 'aircraft');
                this.mapOverlay.updateFromAircraftData(currentState.aircraftData);
            }

            // Update with selected aircraft if any
            if (currentState.selectedAircraft) {
                this.mapOverlay.setSelectedAircraft(currentState.selectedAircraft);
            }
        });

        // Set up style change callback to notify overlay and shape renderer
        this.mapDisplay.onStyleChange(() => {
            if (this.mapOverlay) {
                this.mapOverlay.onStyleChange();
            }
            if (this.shapeRenderer) {
                this.shapeRenderer.onStyleChange();
            }

            // Trigger a display options update to force all renderers to re-render
            // This ensures shapes, aircraft, and routes all appear after style change
            // We use requestAnimationFrame to ensure layers are fully set up first
            requestAnimationFrame(() => {
                const currentOptions = this.stateManager.getDisplayOptions();
                this.stateManager.updateDisplayOptions({...currentOptions});
            });
        });

        // Initialize map interaction managers
        this.shapeDrawingManager = new ShapeDrawingManager(this.mapDisplay, this);
        this.aircraftCreationManager = new AircraftCreationManager(this.mapDisplay);
        this.aircraftInteractionManager = new AircraftInteractionManager(
            this.mapDisplay,
            this.stateManager,
            this.socketManager
        );

        // Now that AircraftInteractionManager is initialized, set up the route data handler
        // This needs to happen after AircraftInteractionManager creation to check for explicit POS commands
        this.setupRouteDataHandler();

        // Connect managers to MapControlsPanel
        this.mapControlsPanel.setShapeDrawingManager(this.shapeDrawingManager);
        this.mapControlsPanel.setAircraftCreationManager(this.aircraftCreationManager);

        logger.debug('App', 'Map display initialized');
        logger.debug('App', 'Shape drawing manager initialized');
        logger.debug('App', 'Aircraft creation manager initialized');
        logger.debug('App', 'Aircraft interaction manager initialized');
    }

    /**
     * Initialize modal dialogs
     */
    private initializeModals(): void {
        // Force initialize the modals system to set up all event handlers
        modals.forceInitialize();
        logger.debug('App', 'Modal system initialized - All modals ready');
    }

    /**
     * Set up global event listeners
     */
    private setupGlobalEventListeners(): void {
        // Handle page visibility changes
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.handlePageHidden();
            } else {
                this.handlePageVisible();
            }
        });

        // Handle before page unload
        window.addEventListener('beforeunload', () => {
            this.cleanup();
        });

        // Handle resize events
        window.addEventListener('resize', () => {
            this.handleResize();
        });
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
            }
        });
    }

    /**
     * Handle page becoming hidden
     */
    private handlePageHidden(): void {
        // Reduce update frequency when page is not visible
        this.socketManager.setReducedUpdates(true);
    }

    /**
     * Handle page becoming visible
     */
    private handlePageVisible(): void {
        // Resume normal update frequency
        this.socketManager.setReducedUpdates(false);
    }

    /**
     * Handle window resize
     */
    private handleResize(): void {
        // Notify components about resize
        // This will trigger map resize, panel adjustments, etc.
        if (this.mapDisplay && this.mapDisplay.isInitialized()) {
            this.mapDisplay.resize();
        }
        logger.debug('App', 'Window resized - updating components');
    }

    /**
     * Update UI based on current state
     */
    private updateUI(): void {
        const state = this.stateManager.getState();

        // Update connection status display (initial call)
        // Uses ConnectionStatusService as single source of truth
        this.updateConnectionStatusDisplay();

        // Update simulation display
        if (state.simInfo) {
            this.updateSimulationDisplay(state.simInfo);
        }

        // Update aircraft display
        if (state.aircraftData) {
            this.updateAircraftDisplay(state.aircraftData);
        }
    }


    /**
     * Update simulation display
     */
    private updateSimulationDisplay(simInfo: SimInfo): void {
        // Update header with simulation info
        this.header.updateSimInfo(simInfo);

        // Update simulation time, speed, aircraft count, etc.
        logger.verbose('App', 'Updating simulation display:', simInfo);
    }

    /**
     * Update aircraft display
     */
    private updateAircraftDisplay(aircraftData: AircraftData): void {
        // Update aircraft positions, trails, etc.
        logger.verbose('App', 'Updating aircraft display:', aircraftData.id.length, 'aircraft');
    }

    /**
     * Send command to simulation
     */
    public sendCommand(command: string): Promise<boolean> {
        return this.socketManager.sendCommand(command);
    }

    /**
     * Add command to history
     */
    public addToHistory(command: string): void {
        // This method is called by Console to keep history in sync
        // For now, we just log it - could implement centralized command history
        logger.verbose('App', 'Command added to history:', command);
    }

    /**
     * Set active simulation node
     */
    public setActiveNode(nodeId: string): void {
        this.socketManager.setActiveNode(nodeId);
        this.stateManager.setActiveNode(nodeId);
    }

    /**
     * Select aircraft
     */
    public selectAircraft(aircraftId: string | null): void {
        this.stateManager.setSelectedAircraft(aircraftId);
        // Update map display to highlight selected aircraft
        logger.debug('App', 'Selected aircraft:', aircraftId);
    }

    /**
     * Get current application state
     */
    public getState(): AppState {
        return this.stateManager.getState();
    }

    /**
     * Get socket manager instance
     */
    public getSocketManager(): SocketManager {
        return this.socketManager;
    }

    /**
     * Get state manager instance
     */
    public getStateManager(): StateManager {
        return this.stateManager;
    }

    /**
     * Get console instance
     */
    public getConsole(): Console {
        return this.console;
    }

    /**
     * Get header instance
     */
    public getHeader(): Header {
        return this.header;
    }

    /**
     * Get traffic list panel instance
     */
    public getTrafficListPanel(): TrafficListPanel {
        return this.trafficListPanel;
    }

    /**
     * Get aircraft info panel instance
     */
    public getAircraftInfoPanel(): AircraftInfoPanel {
        return this.aircraftInfoPanel;
    }

    /**
     * Get conflicts panel instance
     */
    public getConflictsPanel(): ConflictsPanel {
        return this.conflictsPanel;
    }

    /**
     * Get map display instance
     */
    public getMapDisplay(): MapDisplay {
        return this.mapDisplay;
    }

    /**
     * Get map overlay instance
     */
    public getMapOverlay(): MapOverlay | null {
        return this.mapOverlay;
    }

    /**
     * Get map controls panel instance
     */
    public getMapControlsPanel(): MapControlsPanel {
        return this.mapControlsPanel;
    }

    /**
     * Clear all visual elements from the display
     * Called when transitioning from connected to disconnected state
     * Removes: aircraft, shapes, routes, trails, and protected zones
     */
    private clearAllVisualElements(): void {
        logger.info('App', 'Clearing all visual elements (aircraft, shapes, routes, trails, protected zones)');

        // First, explicitly clear aircraft from map with empty data
        // This ensures the map overlay actually clears the display
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

        // Clear all routes
        if (this.mapOverlay) {
            const aircraftRoutes = (this.mapOverlay as any).aircraftRoutes;
            if (aircraftRoutes && typeof aircraftRoutes.clearRouteDisplay === 'function') {
                aircraftRoutes.clearRouteDisplay();
            }
        }

        // Now use existing reset logic to clear simulation state
        // This clears: simInfo, aircraftData, selectedAircraft, activeNode, shapes
        this.stateManager.reset();

        logger.info('App', 'All visual elements cleared successfully');
    }

    /**
     * Clean up resources before page unload
     */
    private cleanup(): void {
        logger.info('App', 'Cleaning up application resources');

        if (this.socketManager) {
            this.socketManager.disconnect();
        }

        if (this.header) {
            this.header.destroy();
        }

        if (this.controls) {
            this.controls.destroy();
        }

        // Clean up panels
        if (this.simulationNodesPanel) {
            this.simulationNodesPanel.destroy();
        }

        if (this.mapControlsPanel) {
            this.mapControlsPanel.destroy();
        }

        if (this.displayOptionsPanel) {
            this.displayOptionsPanel.destroy();
        }

        if (this.trafficListPanel) {
            this.trafficListPanel.destroy();
        }

        if (this.aircraftInfoPanel) {
            this.aircraftInfoPanel.destroy();
        }

        if (this.conflictsPanel) {
            this.conflictsPanel.destroy();
        }

        // Clean up panel resizer
        panelResizer.destroy();

        // Clean up map overlay
        if (this.mapOverlay) {
            this.mapOverlay.destroy();
        }

        // Clean up shape renderer
        if (this.shapeRenderer) {
            this.shapeRenderer.destroy();
        }

        // Clean up interaction managers
        if (this.aircraftInteractionManager) {
            this.aircraftInteractionManager.destroy();
        }

        // Clean up map display
        if (this.mapDisplay) {
            this.mapDisplay.destroy();
        }

        // Clean up other resources as needed
    }

    /**
     * Handle errors in the application
     */
    public handleError(error: Error, context?: string): void {
        logger.error('App', `Application error${context ? ` in ${context}` : ''}:`, error);
        
        // Log error to state for UI display
        // Could implement error toast notifications here
        
        // Optionally report critical errors to monitoring service
        if (error.message.includes('critical') || error.message.includes('fatal')) {
            logger.error('App', 'Critical error detected:', error);
        }
    }

    /**
     * Check if application is initialized
     */
    public isInitialized(): boolean {
        return this.initialized;
    }
}