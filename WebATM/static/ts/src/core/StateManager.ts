import { AppState, SimInfo, AircraftData, ShapeDisplayOptions, ServerStatus, DisplayOptions, CommandDict, Shape, PolygonShape, PolylineShape, PolyData, PolylineData } from '../data/types';
import { logger } from '../utils/Logger';

type StateListener<T> = (newValue: T, oldValue: T) => void;
type ShapeChangeListener = (shapes: Map<string, Shape>) => void;

export class StateManager {
    private state: AppState;
    private listeners: Map<keyof AppState, Set<StateListener<any>>> = new Map();
    private aircraftDrawingMode: boolean = false;
    private aircraftDrawingPoints: [number, number][] = [];

    // Shape storage - indexed by name for fast lookup
    private shapes: Map<string, Shape> = new Map();
    private shapeListeners: Set<ShapeChangeListener> = new Set();

    constructor() {
        this.state = {
            connected: false,
            blueSkyConnected: false,
            receivingData: false,
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
                aircraftIconSize: 0.8,
                mapLabelsTextSize: 12,
                aircraftShape: 'chevron'
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
                    listener(newValue, oldValue);
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

    setConnectionStatus(connected: boolean): void {
        this.updateState('connected', connected);
    }

    setBlueSkyConnectionStatus(connected: boolean): void {
        this.updateState('blueSkyConnected', connected);
    }

    setReceivingDataStatus(receiving: boolean): void {
        this.updateState('receivingData', receiving);
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
            trk: aircraftData.trk[index],
            vs: aircraftData.vs[index],
            inconf: aircraftData.inconf[index],
            tcpamax: aircraftData.tcpamax[index]
        };
    }

    reset(): void {
        const oldState = { ...this.state };

        // IMPORTANT: Preserve connection state during reset!
        // The RESET command only resets the simulation (removes aircraft, resets time, etc.)
        // It does NOT disconnect from the BlueSky server - the connection remains active
        const preservedConnected = this.state.connected;
        const preservedBlueSkyConnected = this.state.blueSkyConnected;
        const preservedReceivingData = this.state.receivingData;
        const preservedServerStatus = this.state.serverStatus;
        const preservedShapeOptions = { ...this.state.shapeOptions };
        const preservedDisplayOptions = { ...this.state.displayOptions };
        const preservedCmddict = this.state.cmddict;

        this.state = {
            // Preserve connection state
            connected: preservedConnected,
            blueSkyConnected: preservedBlueSkyConnected,
            receivingData: preservedReceivingData,
            serverStatus: preservedServerStatus,

            // Reset simulation state
            simInfo: null,
            aircraftData: null,
            selectedAircraft: null,
            activeNode: null,

            // Preserve options (don't reset user preferences!)
            shapeOptions: preservedShapeOptions,
            displayOptions: preservedDisplayOptions,
            cmddict: preservedCmddict
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

    /**
     * Subscribe to shape changes
     * Returns unsubscribe function
     */
    subscribeToShapes(listener: ShapeChangeListener): () => void {
        this.shapeListeners.add(listener);
        return () => {
            this.shapeListeners.delete(listener);
        };
    }

    /**
     * Notify all shape listeners of changes
     */
    public notifyShapeListeners(): void {
        const shapesCopy = new Map(this.shapes);
        this.shapeListeners.forEach(listener => {
            try {
                listener(shapesCopy);
            } catch (error) {
                logger.error('StateManager', 'Error in shape change listener:', error);
            }
        });
    }

    /**
     * Convert PolyData from server format to client PolygonShape format
     * Server sends: {name, lat[], lon[], color?, fill?}
     * Client uses: {type, name, coordinates: {lat, lng}[], ...styling}
     */
    public convertServerPolyToClientShape(data: PolyData, nodeId?: string): PolygonShape {
        // Defensive check: ensure lat and lon arrays exist
        if (!data.lat || !data.lon || !Array.isArray(data.lat) || !Array.isArray(data.lon)) {
            logger.warn('StateManager', 'Invalid PolyData received - missing or invalid lat/lon arrays:', data);
            // Return a minimal valid shape with empty coordinates
            return {
                type: 'polygon',
                name: data.name || 'unnamed',
                visible: true,
                nodeId,
                coordinates: [],
                fillColor: data.color,
                fillOpacity: data.fill ? 0.2 : 0,
                strokeColor: data.color,
                strokeWidth: 2
            };
        }

        const coordinates = data.lat.map((lat, i) => ({
            lat,
            lng: data.lon[i]
        }));

        return {
            type: 'polygon',
            name: data.name,
            visible: true,
            nodeId,
            coordinates,
            fillColor: data.color,
            fillOpacity: 0.2,  // Always set visible opacity - display toggle controls visibility
            strokeColor: data.color,
            strokeWidth: 2
        };
    }

    /**
     * Convert PolylineData from server format to client PolylineShape format
     * Server sends: {name, lat[], lon[], color?, width?}
     * Client uses: {type, name, coordinates: {lat, lng}[], ...styling}
     */
    public convertServerPolylineToClientShape(data: PolylineData, nodeId?: string): PolylineShape {
        // Defensive check: ensure lat and lon arrays exist
        if (!data.lat || !data.lon || !Array.isArray(data.lat) || !Array.isArray(data.lon)) {
            logger.warn('StateManager', 'Invalid PolylineData received - missing or invalid lat/lon arrays:', data);
            // Return a minimal valid shape with empty coordinates
            return {
                type: 'polyline',
                name: data.name || 'unnamed',
                visible: true,
                nodeId,
                coordinates: [],
                color: data.color,
                width: data.width || 2
            };
        }

        const coordinates = data.lat.map((lat, i) => ({
            lat,
            lng: data.lon[i]
        }));

        return {
            type: 'polyline',
            name: data.name,
            visible: true,
            nodeId,
            coordinates,
            color: data.color,
            width: data.width || 2
        };
    }

    /**
     * Add or update a shape
     * @param notify - If false, don't notify listeners (for batch updates)
     */
    addShape(shape: Shape, notify: boolean = true): void {
        const isUpdate = this.shapes.has(shape.name);
        logger.debug('StateManager', `${isUpdate ? 'Updating' : 'Adding'} shape: ${shape.name} (type: ${shape.type})`);
        this.shapes.set(shape.name, shape);
        if (notify) {
            this.notifyShapeListeners();
        }
    }

    /**
     * Add multiple shapes in a batch (only notifies once)
     */
    addShapes(shapes: Shape[]): void {
        logger.debug('StateManager', `Adding ${shapes.length} shapes in batch`);
        shapes.forEach(shape => this.addShape(shape, false));
        this.notifyShapeListeners();
    }

    /**
     * Add or update shape from server PolyData format
     */
    addPolyData(data: PolyData, nodeId?: string): void {
        // Validate data before converting
        if (!data.lat || !data.lon || !Array.isArray(data.lat) || !Array.isArray(data.lon)) {
            logger.warn('StateManager', 'Skipping PolyData - missing or invalid lat/lon arrays');
            return;
        }
        if (data.lat.length === 0 || data.lon.length === 0) {
            logger.warn('StateManager', 'Skipping PolyData - empty lat/lon arrays');
            return;
        }

        const shape = this.convertServerPolyToClientShape(data, nodeId);
        this.addShape(shape);
    }

    /**
     * Add or update shape from server PolylineData format
     */
    addPolylineData(data: PolylineData, nodeId?: string): void {
        // Validate data before converting
        if (!data.lat || !data.lon || !Array.isArray(data.lat) || !Array.isArray(data.lon)) {
            logger.warn('StateManager', 'Skipping PolylineData - missing or invalid lat/lon arrays');
            return;
        }
        if (data.lat.length === 0 || data.lon.length === 0) {
            logger.warn('StateManager', 'Skipping PolylineData - empty lat/lon arrays');
            return;
        }

        const shape = this.convertServerPolylineToClientShape(data, nodeId);
        this.addShape(shape);
    }

    /**
     * Delete a shape by name
     */
    deleteShape(name: string): boolean {
        logger.debug('StateManager', `Deleting shape: ${name}`);
        const deleted = this.shapes.delete(name);
        if (deleted) {
            this.notifyShapeListeners();
        }
        return deleted;
    }

    /**
     * Get a shape by name
     */
    getShape(name: string): Shape | undefined {
        return this.shapes.get(name);
    }

    /**
     * Get all shapes
     */
    getAllShapes(): Map<string, Shape> {
        return new Map(this.shapes);
    }

    /**
     * Get shapes by type
     */
    getShapesByType<T extends Shape['type']>(type: T): Shape[] {
        return Array.from(this.shapes.values()).filter(
            (shape): shape is Extract<Shape, { type: T }> => shape.type === type
        );
    }

    /**
     * Get shapes for a specific node
     */
    getShapesByNode(nodeId: string): Shape[] {
        return Array.from(this.shapes.values()).filter(
            shape => shape.nodeId === nodeId
        );
    }

    /**
     * Clear all shapes
     * Called when switching nodes or resetting simulation
     */
    clearAllShapes(): void {
        logger.debug('StateManager', 'Clearing all shapes');
        this.shapes.clear();
        this.notifyShapeListeners();
    }

    /**
     * Clear shapes for a specific node
     */
    clearShapesForNode(nodeId: string): void {
        logger.debug('StateManager', `Clearing shapes for node: ${nodeId}`);
        let changed = false;

        // Delete all shapes for this node
        for (const [name, shape] of this.shapes.entries()) {
            if (shape.nodeId === nodeId) {
                this.shapes.delete(name);
                changed = true;
            }
        }

        if (changed) {
            this.notifyShapeListeners();
        }
    }

    /**
     * Update shape visibility
     */
    setShapeVisibility(name: string, visible: boolean): void {
        const shape = this.shapes.get(name);
        if (shape && shape.visible !== visible) {
            shape.visible = visible;
            this.notifyShapeListeners();
        }
    }

    /**
     * Get shape count
     */
    getShapeCount(): number {
        return this.shapes.size;
    }
}

export default StateManager;