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
    CommandDictData,
    EchoData,
    Shape,
    ShapeBatchData
} from '../data/types';
import type { StateManager } from './StateManager';
import { parseShapePayload } from './shapePayload';
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
    onEcho?: (data: EchoData) => void;
    onRouteData?: (data: RouteData) => void;
    onConnectionStatus?: (data: ConnectionStatus) => void;
    onServerDisconnected?: () => void;
    onPoly?: (data: PolyData) => void;
    onPolyline?: (data: PolylineData) => void;
    onReset?: () => void;
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
                connectionStatus.setWebSocketConnected(true);
            },
            onDisconnect: () => {
                connectionStatus.setWebSocketConnected(false);
            },
            onReconnect: () => {
                connectionStatus.setWebSocketConnected(true);
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
                }
                if (data.acdata) {
                    this.stateManager.updateAircraftData(data.acdata);
                    connectionStatus.onAircraftDataReceived();
                }
                // Handle cmddict from initial data if available
                if (data.cmddict) {
                    this.stateManager.updateCommandDict(data.cmddict);
                    logger.debug('SocketManager', 'Command dictionary loaded from initial data');
                }

                // Handle poly/polyline data from initial load (for shape
                // persistence). Add in batch mode (no per-shape notify), then
                // render once so a full initial_data load triggers a single
                // render cycle instead of one per shape.
                const shapeCount =
                    this.addInitialShapes(data.poly_data, (item, node) =>
                        this.stateManager.convertServerPolyToClientShape(item, node)) +
                    this.addInitialShapes(data.polyline_data, (item, node) =>
                        this.stateManager.convertServerPolylineToClientShape(item, node));

                if (shapeCount > 0) {
                    logger.debug('SocketManager', `Added ${shapeCount} shapes from initial_data - notifying listeners once`);
                    this.stateManager.notifyShapeListeners();
                }
            },
            onSimInfo: (data: SimInfo) => {
                this.stateManager.updateSimInfo(data);
                connectionStatus.onSimInfoReceived();
            },
            onAircraftData: (data: AircraftData) => {
                this.stateManager.updateAircraftData(data);
                connectionStatus.onAircraftDataReceived();
            },
            onNodeInfo: (data: NodeInfo) => {
                // CRITICAL: Receiving nodeinfo means we're connected to BlueSky!
                connectionStatus.onNodeInfoReceived();

                // Update active node in state if available
                if (data.active_node) {
                    this.stateManager.setActiveNode(data.active_node);
                    logger.debug('SocketManager', 'Active node updated:', data.active_node);
                }
            },
            onEcho: (data: EchoData) => {
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
                }
                // If connected is true, wait for nodeinfo to confirm actual connection
            },
            onServerDisconnected: () => {
                connectionStatus.setBlueSkyConnected(false);
                connectionStatus.setReceivingData(false);
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

    // Pure-forward socket events: each just invokes the handler if set.
    private static readonly FORWARD_EVENTS: ReadonlyArray<[string, keyof SocketEventHandlers]> = [
        ['initial_data', 'onInitialData'],
        ['siminfo', 'onSimInfo'],
        ['acdata', 'onAircraftData'],
        ['command_result', 'onCommandResult'],
        ['node_info', 'onNodeInfo'],
        ['echo', 'onEcho'],
        ['routedata', 'onRouteData'],
        ['connection_status', 'onConnectionStatus'],
        ['server_disconnected', 'onServerDisconnected'],
        ['reset', 'onReset'],
        ['cmddict', 'onCommandDict'],
    ];

    private setupEventListeners(): void {
        if (!this.socket) return;
        const s = this.socket;

        s.on('connect', () => {
            logger.info('SocketManager', 'Connected to WebATM');
            this.connected = true;
            this.reconnectAttempts = 0;
            this.handlers.onConnect?.();
        });

        s.on('disconnect', (reason: string) => {
            logger.info('SocketManager', 'Disconnected from WebATM:', reason);
            this.connected = false;
            this.handlers.onDisconnect?.(reason);
        });

        s.on('reconnect', (attemptNumber: number) => {
            logger.info('SocketManager', 'Reconnected after', attemptNumber, 'attempts');
            this.connected = true;
            this.reconnectAttempts = 0;
            this.handlers.onReconnect?.(attemptNumber);
        });

        s.on('reconnect_error', (error: Error) => {
            logger.warn('SocketManager', 'Reconnection failed:', error);
            this.reconnectAttempts++;
            this.handlers.onReconnectError?.(error);
        });

        for (const [event, key] of SocketManager.FORWARD_EVENTS) {
            s.on(event, (data: unknown) => {
                // The handler map is heterogeneous; the server payload for each
                // event matches the corresponding SocketEventHandlers signature.
                const handler = this.handlers[key] as ((d: unknown) => void) | undefined;
                handler?.(data);
            });
        }

        s.on('poly', (data: unknown) => {
            this.handleShapeEvent<PolyData>(
                'poly',
                data,
                (shape, node) => this.stateManager.addPolyData(shape, node),
                shape => this.handlers.onPoly?.(shape)
            );
        });

        s.on('polyline', (data: unknown) => {
            this.handleShapeEvent<PolylineData>(
                'polyline',
                data,
                (shape, node) => this.stateManager.addPolylineData(shape, node),
                shape => this.handlers.onPolyline?.(shape)
            );
        });
    }

    /**
     * Add shapes from an initial_data envelope in batch mode: converts each
     * valid shape and stores it without notifying, so the caller can render
     * once. Returns how many were added.
     */
    private addInitialShapes<T extends PolyData | PolylineData>(
        payload: ShapeBatchData<T> | undefined,
        convert: (item: T, activeNode: string | undefined) => Shape
    ): number {
        if (!payload) return 0;

        const { validShapes } = parseShapePayload<T>(payload);
        if (validShapes.length === 0) return 0;

        const activeNode = this.stateManager.getState().activeNode || undefined;
        for (const item of validShapes) {
            this.stateManager.addShape(convert(item, activeNode), false);
        }

        // Receiving valid shape data means BlueSky is connected.
        connectionStatus.onShapeDataReceived();
        return validShapes.length;
    }

    /**
     * Shared processing for 'poly' and 'polyline' events. Valid shapes go
     * to the StateManager; the first shape (any validity) is forwarded to
     * the backwards-compatible single-shape handler.
     */
    private handleShapeEvent<T extends PolyData | PolylineData>(
        kind: 'poly' | 'polyline',
        data: unknown,
        addToState: (shape: T, activeNode: string | undefined) => void,
        notifyHandler: (shape: T) => void
    ): void {
        const { validShapes, firstShape, skipped, isEmpty } = parseShapePayload<T>(data);

        if (isEmpty) {
            logger.verbose('SocketManager', `Ignoring empty ${kind} data`);
            return;
        }

        if (skipped.length > 0) {
            logger.verbose('SocketManager', `Skipping invalid ${kind}(s) [${skipped.join(', ')}] - missing or empty lat/lon arrays`);
        }

        const activeNode = this.stateManager.getState().activeNode || undefined;
        for (const shape of validShapes) {
            addToState(shape, activeNode);
        }

        // Mark BlueSky as connected if we received valid shape data
        if (validShapes.length > 0) {
            connectionStatus.onShapeDataReceived();
        }

        if (firstShape) {
            notifyHandler(firstShape);
        }
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