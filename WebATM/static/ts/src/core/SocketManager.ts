import { io, Socket } from 'socket.io-client';
import {
    SimInfo,
    AircraftData,
    RouteData,
    CommandResult,
    NodeInfo,
    ConnectionStatus,
    PolyData,
    PolylineData,
    InitialData,
    CommandDictData
} from '../data/types';
import type { StateManager } from './StateManager';
import { connectionStatus } from './ConnectionStatusService';
import { echoManager } from '../ui/EchoManager';
import { logger } from '../utils/Logger';

interface SocketEventHandlers {
    onConnect?: () => void;
    onDisconnect?: (reason: string) => void;
    onReconnect?: (attemptNumber: number) => void;
    onReconnectError?: (error: Error) => void;
    onInitialData?: (data: InitialData) => void;
    onSimInfo?: (data: SimInfo) => void;
    onAircraftData?: (data: AircraftData) => void;
    onCommandResult?: (data: CommandResult) => void;
    onNodeInfo?: (data: NodeInfo) => void;
    onEcho?: (data: string) => void;
    onRouteData?: (data: RouteData) => void;
    onConnectionStatus?: (data: ConnectionStatus) => void;
    onServerDisconnected?: (data: any) => void;
    onPoly?: (data: PolyData) => void;
    onPolyline?: (data: PolylineData) => void;
    onReset?: (data: any) => void;
    onCommandDict?: (data: CommandDictData) => void;
}

export class SocketManager {
    private socket: Socket | null = null;
    private connected: boolean = false;
    private handlers: SocketEventHandlers = {};
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 10;
    private stateManager: StateManager;

    constructor(stateManager: StateManager) {
        this.stateManager = stateManager;
        this.initializeSocket();
        this.setupStateIntegration();
    }

    private initializeSocket(): void {
        this.socket = io({
            transports: ['websocket', 'polling'],
            timeout: 20000,
            forceNew: true,
            autoConnect: true,
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionAttempts: this.maxReconnectAttempts
        });

        this.setupEventListeners();
    }

    private setupStateIntegration(): void {
        // Set up automatic state updates when socket events are received
        this.setEventHandlers({
            onConnect: () => {
                // Update ConnectionStatusService
                connectionStatus.setWebSocketConnected(true);

                // Keep StateManager in sync (for backwards compatibility)
                this.stateManager.setConnectionStatus(true);
            },
            onDisconnect: () => {
                // Update ConnectionStatusService
                connectionStatus.setWebSocketConnected(false);

                // Keep StateManager in sync (for backwards compatibility)
                this.stateManager.setConnectionStatus(false);
                this.stateManager.setBlueSkyConnectionStatus(false);
                this.stateManager.setReceivingDataStatus(false);
            },
            onReconnect: () => {
                // Update ConnectionStatusService
                connectionStatus.setWebSocketConnected(true);

                // Keep StateManager in sync (for backwards compatibility)
                this.stateManager.setConnectionStatus(true);
            },
            onInitialData: (data: InitialData) => {
                // Process simulation data from initial load
                // Note: We intentionally don't process nodeinfo here to avoid
                // showing "Connected (No Data)" on first page load before user
                // explicitly connects. The nodeinfo event will be emitted separately
                // by the server when data flows through the system.

                if (data.siminfo) {
                    this.stateManager.updateSimInfo(data.siminfo);
                    connectionStatus.onSimInfoReceived();
                    this.stateManager.setReceivingDataStatus(true);
                }
                if (data.acdata) {
                    this.stateManager.updateAircraftData(data.acdata);
                    connectionStatus.onAircraftDataReceived();
                }
                // Handle cmddict from initial data if available
                if ((data as any).cmddict) {
                    this.stateManager.updateCommandDict((data as any).cmddict);
                    logger.debug('SocketManager', 'Command dictionary loaded from initial data');
                }

                // Handle poly/polyline data from initial load (for shape persistence)
                // Process in batch mode to avoid triggering multiple render cycles
                let shapeCount = 0;

                if ((data as any).poly_data) {
                    const polyData = (data as any).poly_data;
                    logger.verbose('SocketManager', 'Processing polygon data from initial_data:', polyData);

                    // Process the poly data - add shapes without notifying yet
                    if (polyData && typeof polyData === 'object' && 'polys' in polyData) {
                        const polysDict = polyData.polys;
                        if (polysDict && typeof polysDict === 'object' && Object.keys(polysDict).length > 0) {
                            const state = this.stateManager.getState();
                            for (const [name, shapeData] of Object.entries(polysDict)) {
                                if (shapeData && typeof shapeData === 'object') {
                                    const polyDataItem = shapeData as PolyData;
                                    if (polyDataItem.lat && polyDataItem.lon &&
                                        Array.isArray(polyDataItem.lat) && Array.isArray(polyDataItem.lon) &&
                                        polyDataItem.lat.length > 0 && polyDataItem.lon.length > 0) {
                                        // Convert and add shape without notifying (false parameter)
                                        const shape = this.stateManager.convertServerPolyToClientShape(polyDataItem, state.activeNode || undefined);
                                        this.stateManager.addShape(shape, false);
                                        shapeCount++;
                                    }
                                }
                            }
                            logger.debug('SocketManager', `Added ${shapeCount} polygons from initial_data (no notification yet)`);

                            // Mark BlueSky as connected since we received shape data
                            connectionStatus.onShapeDataReceived();
                        }
                    }
                }

                if ((data as any).polyline_data) {
                    const polylineData = (data as any).polyline_data;
                    logger.verbose('SocketManager', 'Processing polyline data from initial_data:', polylineData);

                    // Process the polyline data - add shapes without notifying yet
                    if (polylineData && typeof polylineData === 'object' && 'polys' in polylineData) {
                        const polylinesDict = polylineData.polys;
                        if (polylinesDict && typeof polylinesDict === 'object' && Object.keys(polylinesDict).length > 0) {
                            const state = this.stateManager.getState();
                            for (const [name, shapeData] of Object.entries(polylinesDict)) {
                                if (shapeData && typeof shapeData === 'object') {
                                    const polylineDataItem = shapeData as PolylineData;
                                    if (polylineDataItem.lat && polylineDataItem.lon &&
                                        Array.isArray(polylineDataItem.lat) && Array.isArray(polylineDataItem.lon) &&
                                        polylineDataItem.lat.length > 0 && polylineDataItem.lon.length > 0) {
                                        // Convert and add shape without notifying (false parameter)
                                        const shape = this.stateManager.convertServerPolylineToClientShape(polylineDataItem, state.activeNode || undefined);
                                        this.stateManager.addShape(shape, false);
                                        shapeCount++;
                                    }
                                }
                            }
                            logger.debug('SocketManager', `Added ${shapeCount} polylines from initial_data (no notification yet)`);

                            // Mark BlueSky as connected since we received shape data
                            connectionStatus.onShapeDataReceived();
                        }
                    }
                }

                // Notify listeners once after all shapes are added
                if (shapeCount > 0) {
                    logger.debug('SocketManager', `All ${shapeCount} shapes added - notifying listeners once`);
                    this.stateManager.notifyShapeListeners();
                }
            },
            onSimInfo: (data: SimInfo) => {
                this.stateManager.updateSimInfo(data);
                connectionStatus.onSimInfoReceived();
                this.stateManager.setReceivingDataStatus(true);
            },
            onAircraftData: (data: AircraftData) => {
                this.stateManager.updateAircraftData(data);
                connectionStatus.onAircraftDataReceived();
                this.stateManager.setReceivingDataStatus(true);
            },
            onNodeInfo: (data: NodeInfo) => {
                // CRITICAL: Receiving nodeinfo means we're connected to BlueSky!
                connectionStatus.onNodeInfoReceived();
                this.stateManager.setBlueSkyConnectionStatus(true);

                // Update active node in state if available
                if (data.active_node) {
                    this.stateManager.setActiveNode(data.active_node);
                    logger.debug('SocketManager', 'Active node updated:', data.active_node);
                }
            },
            onEcho: (data: any) => {
                // Handle echo messages from BlueSky server
                if (data && data.text) {
                    // Determine message type based on flags
                    // flags: 0 = info (default), 1 = error, 2 = warning
                    let messageType = 'info';
                    if (data.flags === 1) {
                        messageType = 'error';
                    } else if (data.flags === 2) {
                        messageType = 'warning';
                    }

                    // Extract node ID from sender field if available
                    // Also try to get active node from state as fallback
                    let nodeId = data.sender || undefined;

                    // If no sender in data, get active node from state manager
                    if (!nodeId) {
                        const state = this.stateManager.getState();
                        nodeId = state.activeNode || undefined;
                    }

                    // Debug logging to see what we're receiving
                    logger.verbose('SocketManager', 'Echo data:', { text: data.text, sender: data.sender, nodeId, flags: data.flags });

                    echoManager.addMessage(data.text, messageType, nodeId);
                }
            },
            onConnectionStatus: (data: ConnectionStatus) => {
                // connection_status event from server indicates BlueSky connection
                // However, we should only trust this for disconnection events
                // For connection, we rely on nodeinfo as the source of truth
                if (!data.connected) {
                    // Only set disconnected state from connection_status
                    connectionStatus.setBlueSkyConnected(false);
                    this.stateManager.setBlueSkyConnectionStatus(false);
                }
                // If connected is true, wait for nodeinfo to confirm actual connection
            },
            onServerDisconnected: () => {
                connectionStatus.setBlueSkyConnected(false);
                connectionStatus.setReceivingData(false);
                this.stateManager.setBlueSkyConnectionStatus(false);
                this.stateManager.setReceivingDataStatus(false);
            },
            onReset: () => {
                // IMPORTANT: RESET only resets simulation data, NOT connection status!
                // The simulation is reset but we're still connected to BlueSky server
                this.stateManager.reset();
                logger.info('SocketManager', 'Simulation reset - connection maintained');
            },
            onCommandDict: (data: CommandDictData) => {
                // Update command dictionary from server
                this.stateManager.updateCommandDict(data.cmddict);
                logger.debug('SocketManager', 'Command dictionary updated:', Object.keys(data.cmddict).length, 'commands');
            }
        });
    }

    private setupEventListeners(): void {
        if (!this.socket) return;

        this.socket.on('connect', () => {
            logger.info('SocketManager', 'Connected to WebATM');
            this.connected = true;
            this.reconnectAttempts = 0;
            
            if (this.handlers.onConnect) {
                this.handlers.onConnect();
            }
        });

        this.socket.on('disconnect', (reason: string) => {
            logger.info('SocketManager', 'Disconnected from WebATM:', reason);
            this.connected = false;
            
            if (this.handlers.onDisconnect) {
                this.handlers.onDisconnect(reason);
            }
        });

        this.socket.on('reconnect', (attemptNumber: number) => {
            logger.info('SocketManager', 'Reconnected after', attemptNumber, 'attempts');
            this.connected = true;
            this.reconnectAttempts = 0;
            
            if (this.handlers.onReconnect) {
                this.handlers.onReconnect(attemptNumber);
            }
        });

        this.socket.on('reconnect_error', (error: Error) => {
            logger.warn('SocketManager', 'Reconnection failed:', error);
            this.reconnectAttempts++;
            
            if (this.handlers.onReconnectError) {
                this.handlers.onReconnectError(error);
            }
        });

        this.socket.on('initial_data', (data: InitialData) => {
            if (this.handlers.onInitialData) {
                this.handlers.onInitialData(data);
            }
        });

        this.socket.on('siminfo', (data: SimInfo) => {
            if (this.handlers.onSimInfo) {
                this.handlers.onSimInfo(data);
            }
        });

        this.socket.on('acdata', (data: AircraftData) => {
            if (this.handlers.onAircraftData) {
                this.handlers.onAircraftData(data);
            }
        });

        this.socket.on('command_result', (data: CommandResult) => {
            if (this.handlers.onCommandResult) {
                this.handlers.onCommandResult(data);
            }
        });

        this.socket.on('node_info', (data: NodeInfo) => {
            if (this.handlers.onNodeInfo) {
                this.handlers.onNodeInfo(data);
            }
        });

        this.socket.on('echo', (data: string) => {
            if (this.handlers.onEcho) {
                this.handlers.onEcho(data);
            }
        });

        this.socket.on('routedata', (data: RouteData) => {
            if (this.handlers.onRouteData) {
                this.handlers.onRouteData(data);
            }
        });

        this.socket.on('connection_status', (data: ConnectionStatus) => {
            if (this.handlers.onConnectionStatus) {
                this.handlers.onConnectionStatus(data);
            }
        });

        this.socket.on('server_disconnected', (data: any) => {
            if (this.handlers.onServerDisconnected) {
                this.handlers.onServerDisconnected(data);
            }
        });

        this.socket.on('poly', (data: any) => {
            // Handle the server's format which can be:
            // 1. {'polys': {...}} - dictionary of shapes
            // 2. PolyData - single shape
            // 3. PolyData[] - array of shapes

            // Check if data is in the BlueSky proxy format with 'polys' dictionary
            if (data && typeof data === 'object' && 'polys' in data) {
                const polysDict = data.polys;

                // If polys is empty or not an object, ignore
                if (!polysDict || typeof polysDict !== 'object' || Object.keys(polysDict).length === 0) {
                    logger.verbose('SocketManager', 'Ignoring empty poly data');
                    return;
                }

                // Process each shape in the dictionary
                const state = this.stateManager.getState();
                let validShapeCount = 0;
                for (const [name, shapeData] of Object.entries(polysDict)) {
                    if (shapeData && typeof shapeData === 'object') {
                        const polyData = shapeData as PolyData;
                        // Validate that the shape has valid lat/lon arrays
                        if (polyData.lat && polyData.lon &&
                            Array.isArray(polyData.lat) && Array.isArray(polyData.lon) &&
                            polyData.lat.length > 0 && polyData.lon.length > 0) {
                            this.stateManager.addPolyData(polyData, state.activeNode || undefined);
                            validShapeCount++;
                        } else {
                            logger.verbose('SocketManager', `Skipping invalid poly '${name}' - missing or empty lat/lon arrays`);
                        }
                    }
                }

                // Mark BlueSky as connected if we received valid shape data
                if (validShapeCount > 0) {
                    connectionStatus.onShapeDataReceived();
                }

                if (this.handlers.onPoly) {
                    // For backwards compatibility, pass the first shape
                    const firstShape = Object.values(polysDict)[0] as PolyData;
                    if (firstShape) {
                        this.handlers.onPoly(firstShape);
                    }
                }
            } else {
                // Handle legacy format: single shape or array of shapes
                const shapes = Array.isArray(data) ? data : [data];
                const state = this.stateManager.getState();
                let validShapeCount = 0;

                shapes.forEach((polyData: PolyData) => {
                    // Validate that the shape has valid lat/lon arrays
                    if (polyData && polyData.lat && polyData.lon &&
                        Array.isArray(polyData.lat) && Array.isArray(polyData.lon) &&
                        polyData.lat.length > 0 && polyData.lon.length > 0) {
                        this.stateManager.addPolyData(polyData, state.activeNode || undefined);
                        validShapeCount++;
                    } else {
                        logger.verbose('SocketManager', 'Skipping invalid poly - missing or empty lat/lon arrays');
                    }
                });

                // Mark BlueSky as connected if we received valid shape data
                if (validShapeCount > 0) {
                    connectionStatus.onShapeDataReceived();
                }

                if (this.handlers.onPoly) {
                    this.handlers.onPoly(Array.isArray(data) ? data[0] : data);
                }
            }
        });

        this.socket.on('polyline', (data: any) => {
            // Handle the server's format which can be:
            // 1. {'polys': {...}} - dictionary of shapes (using 'polys' key for consistency)
            // 2. PolylineData - single shape
            // 3. PolylineData[] - array of shapes

            // Check if data is in the BlueSky proxy format with 'polys' dictionary
            if (data && typeof data === 'object' && 'polys' in data) {
                const polylinesDict = data.polys;

                // If polys is empty or not an object, ignore
                if (!polylinesDict || typeof polylinesDict !== 'object' || Object.keys(polylinesDict).length === 0) {
                    logger.verbose('SocketManager', 'Ignoring empty polyline data');
                    return;
                }

                // Process each shape in the dictionary
                const state = this.stateManager.getState();
                let validShapeCount = 0;
                for (const [name, shapeData] of Object.entries(polylinesDict)) {
                    if (shapeData && typeof shapeData === 'object') {
                        const polylineData = shapeData as PolylineData;

                        // Enhanced debugging for polyline validation
                        logger.verbose('SocketManager', `🔍 DEBUG Processing polyline '${name}':`, {
                            keys: Object.keys(shapeData),
                            hasLat: 'lat' in shapeData,
                            hasLon: 'lon' in shapeData,
                            latValue: (shapeData as any).lat,
                            lonValue: (shapeData as any).lon,
                            latIsArray: Array.isArray((shapeData as any).lat),
                            lonIsArray: Array.isArray((shapeData as any).lon),
                            fullData: shapeData
                        });

                        // Validate that the shape has valid lat/lon arrays
                        if (polylineData.lat && polylineData.lon &&
                            Array.isArray(polylineData.lat) && Array.isArray(polylineData.lon) &&
                            polylineData.lat.length > 0 && polylineData.lon.length > 0) {
                            logger.verbose('SocketManager', `Polyline '${name}' is valid, adding to state`);
                            this.stateManager.addPolylineData(polylineData, state.activeNode || undefined);
                            validShapeCount++;
                        } else {
                            logger.verbose('SocketManager', `❌ Skipping invalid polyline '${name}' - missing or empty lat/lon arrays`);
                        }
                    }
                }

                // Mark BlueSky as connected if we received valid shape data
                if (validShapeCount > 0) {
                    connectionStatus.onShapeDataReceived();
                }

                if (this.handlers.onPolyline) {
                    // For backwards compatibility, pass the first shape
                    const firstShape = Object.values(polylinesDict)[0] as PolylineData;
                    if (firstShape) {
                        this.handlers.onPolyline(firstShape);
                    }
                }
            } else {
                // Handle legacy format: single shape or array of shapes
                const shapes = Array.isArray(data) ? data : [data];
                const state = this.stateManager.getState();
                let validShapeCount = 0;

                shapes.forEach((polylineData: PolylineData) => {
                    // Validate that the shape has valid lat/lon arrays
                    if (polylineData && polylineData.lat && polylineData.lon &&
                        Array.isArray(polylineData.lat) && Array.isArray(polylineData.lon) &&
                        polylineData.lat.length > 0 && polylineData.lon.length > 0) {
                        this.stateManager.addPolylineData(polylineData, state.activeNode || undefined);
                        validShapeCount++;
                    } else {
                        logger.verbose('SocketManager', 'Skipping invalid polyline - missing or empty lat/lon arrays');
                    }
                });

                // Mark BlueSky as connected if we received valid shape data
                if (validShapeCount > 0) {
                    connectionStatus.onShapeDataReceived();
                }

                if (this.handlers.onPolyline) {
                    this.handlers.onPolyline(Array.isArray(data) ? data[0] : data);
                }
            }
        });

        this.socket.on('reset', (data: any) => {
            if (this.handlers.onReset) {
                this.handlers.onReset(data);
            }
        });

        this.socket.on('cmddict', (data: CommandDictData) => {
            if (this.handlers.onCommandDict) {
                this.handlers.onCommandDict(data);
            }
        });
    }

    setEventHandlers(handlers: Partial<SocketEventHandlers>): void {
        this.handlers = { ...this.handlers, ...handlers };
    }

    connect(): void {
        if (this.socket && !this.connected) {
            this.socket.connect();
        }
    }

    disconnect(): void {
        if (this.socket && this.connected) {
            this.socket.disconnect();
        }
    }

    isConnected(): boolean {
        return this.connected && this.socket?.connected === true;
    }

    sendCommand(command: string): Promise<boolean> {
        return new Promise((resolve) => {
            if (this.isConnected() && this.socket) {
                this.socket.emit('command', { command });
                resolve(true);
            } else {
                logger.warn('SocketManager', 'Cannot send command: not connected to WebATM');
                resolve(false);
            }
        });
    }

    setActiveNode(nodeId: string): void {
        if (this.isConnected() && this.socket) {
            this.socket.emit('set_active_node', { node_id: nodeId });
        } else {
            logger.warn('SocketManager', 'Cannot set active node: not connected to WebATM');
        }
    }

    requestNodes(): void {
        if (this.isConnected() && this.socket) {
            this.socket.emit('get_nodes');
        } else {
            logger.warn('SocketManager', 'Cannot request nodes: not connected to WebATM');
        }
    }

    getReconnectAttempts(): number {
        return this.reconnectAttempts;
    }

    getMaxReconnectAttempts(): number {
        return this.maxReconnectAttempts;
    }

    setMaxReconnectAttempts(attempts: number): void {
        this.maxReconnectAttempts = attempts;
    }

    destroy(): void {
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.disconnect();
            this.socket = null;
        }
        this.connected = false;
        this.handlers = {};
    }

    getSocket(): Socket | null {
        return this.socket;
    }

    setReducedUpdates(enabled: boolean): void {
        // This method can be used to throttle updates when page is not visible
        // For now, just log the state change - actual throttling logic can be added later
        logger.debug('SocketManager', `Reduced updates mode: ${enabled}`);
    }

    async initialize(): Promise<void> {
        // Initialize socket connection if needed
        // This method is called by App.ts during initialization
        if (!this.socket) {
            this.initializeSocket();
        }
    }
}

export default SocketManager;
export type { SocketEventHandlers };