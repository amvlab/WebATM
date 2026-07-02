import { AppState, SimInfo, AircraftData, ShapeDisplayOptions, ServerStatus, DisplayOptions, CommandDict, Shape, PolygonShape, PolylineShape, PolyData, PolylineData } from '../data/types';
import { AUTO_MODEL_SENTINEL } from '../data/aircraftCategories';
import { ShapeStore, ShapeChangeListener, polyDataToShape, polylineDataToShape } from './ShapeStore';
import { logger } from '../utils/Logger';

type StateListener<T> = (newValue: T, oldValue: T) => void;

export class StateManager {
    private state: AppState;
    // Listener sets are heterogeneous across keys; StateListener<never>
    // accepts any key-specific listener, and notifyListeners restores the
    // key-specific type before invoking.
    private listeners: Map<keyof AppState, Set<StateListener<never>>> = new Map();
    private aircraftDrawingMode: boolean = false;
    private aircraftDrawingPoints: [number, number][] = [];

    // Shape storage - indexed by name for fast lookup
    private shapeStore = new ShapeStore();

    constructor() {
        this.state = {
            simInfo: null,
            aircraftData: null,
            selectedAircraft: null,
            activeNode: null,
            shapeOptions: {
                showShapes: true,
                showShapeFill: false,
                showShapeLines: true,
                showShapeLabels: false
            },
            serverStatus: 'unknown',
            cmddict: null,
            aircraftModelOverrides: {},
            aircraftScaleOverrides: {},
            displayOptions: {
                // Text sizes - defaults
                headerFontSize: 20,   // Header text size
                consoleFontSize: 11,  // Applies to both console and echo
                panelFontSize: 11,    // Panel text size
                // Speed display
                speedType: 'tas',
                // Units - defaults
                speedUnit: 'knots',
                altitudeUnit: 'fl',
                verticalSpeedUnit: 'ft/min',
                // Collapsible sections
                sizesVisible: false,
                colorsVisible: false,
                unitsVisible: false,
                // Color customization - defaults matching current hard-coded colors
                aircraftIconColor: '#00ff00',
                aircraftLabelColor: '#0066cc',
                aircraftSelectedColor: '#ff6600',
                aircraftConflictColor: '#ffa000',
                aircraftTrailColor: '#0066cc',
                trailConflictColor: '#ffa000',
                protectedZonesColor: '#00ff00',
                routeLabelsColor: '#ff00ff',
                routePointsColor: '#ff00ff',
                routeLinesColor: '#ff00ff',
                shapeFillColor: '#ff00ff',
                shapeLinesColor: '#ff00ff',
                shapeLabelsColor: '#ff00ff',
                // Future map options - defaults from JS
                showAircraft: true,
                showAircraftLabels: true,
                showAircraftId: true,
                showAircraftSpeed: true,
                showAircraftAltitude: true,
                showAircraftType: true,
                showAircraftTrails: false,
                showProtectedZones: false,
                showRoutes: true,
                showRouteLines: true,
                showRouteLabels: true,
                showRoutePoints: true,
                showShapes: true,
                showShapeFill: true,
                showShapeLines: true,
                showShapeLabels: true,
                // Navigation data overlay - airports on by default, waypoint
                // labels off (there are far too many to label at once).
                showAirports: true,
                showAirportIcons: true,
                showAirportLabels: true,
                // Heliports are noisy (apt.dat has thousands), so off by default.
                showHeliports: false,
                showWaypoints: true,
                showWaypointIcons: true,
                showWaypointLabels: false,
                showRunways: true,
                showRunwayLabels: true,
                showPavement: true,
                snapToNavaids: true,
                // Search bar is visible by default.
                showSearchBar: true,
                airportColor: '#4da3ff',
                heliportColor: '#e0823c',
                waypointColor: '#9aa7b4',
                runwayColor: '#c8d2dc',
                pavementColor: '#5a6470',
                aircraftIconSize: 0.8,
                mapLabelsTextSize: 12,
                aircraftShape: 'chevron',
                // Rendering mode - deprecated, kept for backwards compatibility
                renderMode: '2d',
                // 3D overlay toggle - 2D is always active
                show3DOverlay: false,
                aircraft3DModelQuality: 'medium',
                aircraft3DScale: 2.0,
                selectedAircraftModel: AUTO_MODEL_SENTINEL, // per-type category-based model selection by default
                threeDVisible: false // 3D section collapsed by default
            }
        };
    }

    getState(): Readonly<AppState> {
        return { ...this.state };
    }

    subscribe<K extends keyof AppState>(
        key: K,
        listener: StateListener<AppState[K]>
    ): () => void {
        if (!this.listeners.has(key)) {
            this.listeners.set(key, new Set());
        }
        this.listeners.get(key)!.add(listener);

        return () => {
            const keyListeners = this.listeners.get(key);
            if (keyListeners) {
                keyListeners.delete(listener);
                if (keyListeners.size === 0) {
                    this.listeners.delete(key);
                }
            }
        };
    }

    private notifyListeners<K extends keyof AppState>(
        key: K,
        newValue: AppState[K],
        oldValue: AppState[K]
    ): void {
        const keyListeners = this.listeners.get(key);
        if (keyListeners) {
            keyListeners.forEach(listener => {
                try {
                    (listener as StateListener<AppState[K]>)(newValue, oldValue);
                } catch (error) {
                    logger.error('StateManager', `Error in state listener for ${String(key)}:`, error);
                }
            });
        }
    }

    updateState<K extends keyof AppState>(
        key: K,
        value: AppState[K]
    ): void {
        const oldValue = this.state[key];
        if (oldValue !== value) {
            this.state[key] = value;
            this.notifyListeners(key, value, oldValue);
        }
    }

    updateSimInfo(simInfo: SimInfo): void {
        this.updateState('simInfo', simInfo);
    }

    /**
     * Get the per-aircraft 3D model override for an aircraft, or null
     * if no override is set.
     */
    getAircraftModelOverride(acid: string): string | null {
        return this.state.aircraftModelOverrides[acid] ?? null;
    }

    /**
     * Set or clear the per-aircraft 3D model override. Passing null
     * removes any existing override. Notifies listeners of
     * `aircraftModelOverrides` on change.
     */
    setAircraftModelOverride(acid: string, modelFile: string | null): void {
        const current = this.state.aircraftModelOverrides;
        const existing = current[acid] ?? null;
        if (existing === modelFile) return;

        const next = { ...current };
        if (modelFile === null) {
            delete next[acid];
        } else {
            next[acid] = modelFile;
        }
        this.updateState('aircraftModelOverrides', next);
    }

    /**
     * Get the per-aircraft 3D scale override for an aircraft, or null
     * if no override is set.
     */
    getAircraftScaleOverride(acid: string): number | null {
        const value = this.state.aircraftScaleOverrides[acid];
        return typeof value === 'number' ? value : null;
    }

    /**
     * Set or clear the per-aircraft 3D scale override. Passing null
     * removes any existing override. Notifies listeners of
     * `aircraftScaleOverrides` on change.
     */
    setAircraftScaleOverride(acid: string, scale: number | null): void {
        const current = this.state.aircraftScaleOverrides;
        const existing = typeof current[acid] === 'number' ? current[acid] : null;
        if (existing === scale) return;

        const next = { ...current };
        if (scale === null) {
            delete next[acid];
        } else {
            next[acid] = scale;
        }
        this.updateState('aircraftScaleOverrides', next);
    }

    updateAircraftData(aircraftData: AircraftData): void {
        this.updateState('aircraftData', aircraftData);
    }

    setSelectedAircraft(aircraftId: string | null): void {
        this.updateState('selectedAircraft', aircraftId);
    }

    setActiveNode(nodeId: string | null): void {
        const oldNodeId = this.state.activeNode;

        // Only clear shapes when switching between actual nodes
        // Don't clear when going from null (initial state) to first node
        if (oldNodeId !== nodeId && oldNodeId !== null) {
            logger.info('StateManager', `Switching from node "${oldNodeId}" to "${nodeId}" - clearing shapes`);
            this.clearAllShapes();
        } else if (oldNodeId === null && nodeId !== null) {
            logger.debug('StateManager', `Initial node set to "${nodeId}" - preserving shapes`);
        }

        this.updateState('activeNode', nodeId);
    }

    updateShapeOptions(options: Partial<ShapeDisplayOptions>): void {
        const newShapeOptions = { ...this.state.shapeOptions, ...options };
        this.updateState('shapeOptions', newShapeOptions);
    }

    updateServerStatus(status: ServerStatus): void {
        this.updateState('serverStatus', status);
    }

    getServerStatus(): ServerStatus {
        return this.state.serverStatus;
    }

    updateDisplayOptions(options: Partial<DisplayOptions>): void {
        const newDisplayOptions = { ...this.state.displayOptions, ...options };
        this.updateState('displayOptions', newDisplayOptions);

        // When the user changes the global 3D model selection, drop all
        // per-aircraft overrides — the new global choice should win. Any
        // previously pinned aircraft revert to "Auto" / forced global.
        if (
            'selectedAircraftModel' in options
            && options.selectedAircraftModel !== undefined
            && Object.keys(this.state.aircraftModelOverrides).length > 0
        ) {
            this.updateState('aircraftModelOverrides', {});
        }

        // Same policy for the global 3D scale: changing it wipes any
        // per-aircraft scale overrides so the new global value wins.
        if (
            'aircraft3DScale' in options
            && options.aircraft3DScale !== undefined
            && Object.keys(this.state.aircraftScaleOverrides).length > 0
        ) {
            this.updateState('aircraftScaleOverrides', {});
        }
    }

    getDisplayOptions(): DisplayOptions {
        return { ...this.state.displayOptions };
    }

    updateCommandDict(cmddict: CommandDict): void {
        this.updateState('cmddict', cmddict);
    }

    getCommandDict(): CommandDict | null {
        return this.state.cmddict;
    }

    getSimulationState(): { state: string; speed: number; time: number } {
        const simInfo = this.state.simInfo;
        if (!simInfo) {
            return { state: 'UNKNOWN', speed: 0, time: 0 };
        }
        
        const stateNames = ['INIT', 'HOLD', 'OP', 'END'];
        const stateName = stateNames[simInfo.state] || 'UNKNOWN';
        
        return {
            state: stateName,
            speed: simInfo.speed,
            time: simInfo.simt
        };
    }

    setAircraftDrawingMode(enabled: boolean): void {
        const oldValue = this.aircraftDrawingMode;
        this.aircraftDrawingMode = enabled;
        if (enabled !== oldValue) {
            if (!enabled) {
                this.aircraftDrawingPoints = [];
            }
        }
    }

    isAircraftDrawingMode(): boolean {
        return this.aircraftDrawingMode;
    }

    addAircraftDrawingPoint(point: [number, number]): void {
        if (this.aircraftDrawingMode) {
            this.aircraftDrawingPoints.push(point);
        }
    }

    getAircraftDrawingPoints(): readonly [number, number][] {
        return [...this.aircraftDrawingPoints];
    }

    clearAircraftDrawingPoints(): void {
        this.aircraftDrawingPoints = [];
    }

    getSimulationTime(): number {
        return this.state.simInfo?.simt || 0;
    }

    getSimulationSpeed(): number {
        return this.state.simInfo?.speed || 1;
    }

    getAircraftCount(): number {
        return this.state.simInfo?.ntraf || 0;
    }

    getSelectedAircraftData(): {
        id: string;
        lat: number;
        lon: number;
        alt: number;
        tas: number;
        actype: string;
        trk: number;
        vs: number;
        inconf: boolean;
        tcpamax: number;
    } | null {
        const { selectedAircraft, aircraftData } = this.state;
        if (!selectedAircraft || !aircraftData) return null;

        const index = aircraftData.id.indexOf(selectedAircraft);
        if (index === -1) return null;

        return {
            id: selectedAircraft,
            lat: aircraftData.lat[index],
            lon: aircraftData.lon[index],
            alt: aircraftData.alt[index],
            tas: aircraftData.tas[index],
            actype: aircraftData.actype && aircraftData.actype[index] ? aircraftData.actype[index] : '',
            trk: aircraftData.trk[index],
            vs: aircraftData.vs[index],
            inconf: aircraftData.inconf[index],
            tcpamax: aircraftData.tcpamax[index]
        };
    }

    getAircraftById(aircraftId: string): {
        id: string;
        lat: number;
        lon: number;
        alt: number;
        tas: number;
        actype: string;
        trk: number;
        vs: number;
        inconf: boolean;
        tcpamax: number;
    } | null {
        const { aircraftData } = this.state;
        if (!aircraftData) return null;

        const index = aircraftData.id.indexOf(aircraftId);
        if (index === -1) return null;

        return {
            id: aircraftId,
            lat: aircraftData.lat[index],
            lon: aircraftData.lon[index],
            alt: aircraftData.alt[index],
            tas: aircraftData.tas[index],
            actype: aircraftData.actype && aircraftData.actype[index] ? aircraftData.actype[index] : '',
            trk: aircraftData.trk[index],
            vs: aircraftData.vs[index],
            inconf: aircraftData.inconf[index],
            tcpamax: aircraftData.tcpamax[index]
        };
    }

    reset(): void {
        const oldState = { ...this.state };

        // IMPORTANT: Server status is tracked independently of BlueSky connection
        // state (which now lives solely in ConnectionStatusService) and is
        // preserved here for the same reason: RESET only resets the simulation,
        // it does not affect server/connection state.
        const preservedServerStatus = this.state.serverStatus;
        const preservedShapeOptions = { ...this.state.shapeOptions };
        const preservedDisplayOptions = { ...this.state.displayOptions };
        const preservedCmddict = this.state.cmddict;

        this.state = {
            serverStatus: preservedServerStatus,

            // Reset simulation state
            simInfo: null,
            aircraftData: null,
            selectedAircraft: null,
            activeNode: null,

            // Preserve options (don't reset user preferences!)
            shapeOptions: preservedShapeOptions,
            displayOptions: preservedDisplayOptions,
            cmddict: preservedCmddict,

            // Clear per-aircraft overrides when the simulation resets —
            // the old aircraft IDs are no longer meaningful.
            aircraftModelOverrides: {},
            aircraftScaleOverrides: {},
        };
        this.aircraftDrawingMode = false;
        this.aircraftDrawingPoints = [];

        // Clear all shapes on reset (shapes belong to simulation, not preserved)
        this.clearAllShapes();

        // Only notify listeners for fields that actually changed
        Object.keys(oldState).forEach(key => {
            const stateKey = key as keyof AppState;
            const oldValue = oldState[stateKey];
            const newValue = this.state[stateKey];

            // Only notify if the value actually changed
            if (oldValue !== newValue) {
                this.notifyListeners(stateKey, newValue, oldValue);
            }
        });
    }

    // ==================== Shape Management ====================
    // Thin facade over ShapeStore so existing callers keep their API.

    subscribeToShapes(listener: ShapeChangeListener): () => void {
        return this.shapeStore.subscribe(listener);
    }

    public notifyShapeListeners(): void {
        this.shapeStore.notifyListeners();
    }

    public convertServerPolyToClientShape(data: PolyData, nodeId?: string): PolygonShape {
        return polyDataToShape(data, nodeId);
    }

    public convertServerPolylineToClientShape(data: PolylineData, nodeId?: string): PolylineShape {
        return polylineDataToShape(data, nodeId);
    }

    addShape(shape: Shape, notify: boolean = true): void {
        this.shapeStore.add(shape, notify);
    }

    addShapes(shapes: Shape[]): void {
        this.shapeStore.addBatch(shapes);
    }

    addPolyData(data: PolyData, nodeId?: string): void {
        this.shapeStore.addPolyData(data, nodeId);
    }

    addPolylineData(data: PolylineData, nodeId?: string): void {
        this.shapeStore.addPolylineData(data, nodeId);
    }

    deleteShape(name: string): boolean {
        return this.shapeStore.delete(name);
    }

    getShape(name: string): Shape | undefined {
        return this.shapeStore.get(name);
    }

    getAllShapes(): Map<string, Shape> {
        return this.shapeStore.getAll();
    }

    getShapesByType<T extends Shape['type']>(type: T): Shape[] {
        return this.shapeStore.getByType(type);
    }

    getShapesByNode(nodeId: string): Shape[] {
        return this.shapeStore.getByNode(nodeId);
    }

    clearAllShapes(): void {
        this.shapeStore.clear();
    }

    clearShapesForNode(nodeId: string): void {
        this.shapeStore.clearForNode(nodeId);
    }

    setShapeVisibility(name: string, visible: boolean): void {
        this.shapeStore.setVisibility(name, visible);
    }

    getShapeCount(): number {
        return this.shapeStore.size;
    }
}

export default StateManager;