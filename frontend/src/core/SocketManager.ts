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

/**
 * True when a snapshot field carries actual data. The proxy clears its
 * caches to `{}` on disconnect, so an empty object means "no data" and
 * must not flip the connection status.
 */
function hasEntries<T extends object>(value: T | undefined): value is T {
    return value !== undefined && value !== null && Object.keys(value).length > 0;
}

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
                // node_info is deliberately not processed here so a fresh
                // page load doesn't show "Connected (No Data)" before live
                // data flows; the server emits nodeinfo separately.

                if (hasEntries(data.sim_data)) {
                    this.stateManager.updateSimInfo(data.sim_data);
                    connectionStatus.onSimInfoReceived();
                }
                if (hasEntries(data.traffic_data)) {
                    this.stateManager.updateAircraftData(data.traffic_data);
                    connectionStatus.onAircraftDataReceived();
                }
                if (hasEntries(data.cmddict)) {
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
                // Receiving nodeinfo means we're connected to BlueSky.
                connectionStatus.onNodeInfoReceived();

                if (data.active_node) {
                    this.stateManager.setActiveNode(data.active_node);
                    logger.debug('SocketManager', 'Active node updated:', data.active_node);
                }
            },
            onEcho: (data: EchoData) => {
                if (data && data.text) {
                    // flags: 0 = info (default), 1 = error, 2 = warning
                    let messageType = 'info';
                    if (data.flags === 1) {
                        messageType = 'error';
                    } else if (data.flags === 2) {
                        messageType = 'warning';
                    }

                    // Attribute to the sending node, falling back to the active node.
                    const nodeId = data.sender || this.stateManager.getState().activeNode || undefined;

                    logger.verbose('SocketManager', 'Echo data:', { text: data.text, sender: data.sender, nodeId, flags: data.flags });

                    echoManager.addMessage(data.text, messageType, nodeId);
                }
            },
            onConnectionStatus: (data: ConnectionStatus) => {
                // Only trust connection_status for disconnection; connection is
                // confirmed by nodeinfo (the source of truth for "connected").
                if (!data.connected) {
                    connectionStatus.setBlueSkyConnected(false);
                }
            },
            onServerDisconnected: () => {
                connectionStatus.setBlueSkyConnected(false);
                connectionStatus.setReceivingData(false);
            },
            onReset: () => {
                // RESET clears simulation data only - we stay connected to BlueSky.
                this.stateManager.reset();
                logger.info('SocketManager', 'Simulation reset - connection maintained');
            },
            onCommandDict: (data: CommandDictData) => {
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
                (shape, node) => this.stateManager.addPolyData(shape, node)
            );
        });

        s.on('polyline', (data: unknown) => {
            this.handleShapeEvent<PolylineData>(
                'polyline',
                data,
                (shape, node) => this.stateManager.addPolylineData(shape, node)
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
     * Shared processing for 'poly' and 'polyline' events: valid shapes go
     * to the StateManager, invalid ones are logged and skipped.
     */
    private handleShapeEvent<T extends PolyData | PolylineData>(
        kind: 'poly' | 'polyline',
        data: unknown,
        addToState: (shape: T, activeNode: string | undefined) => void
    ): void {
        const { validShapes, skipped, isEmpty } = parseShapePayload<T>(data);

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

        // Receiving valid shape data means BlueSky is connected.
        if (validShapes.length > 0) {
            connectionStatus.onShapeDataReceived();
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
        // Placeholder for throttling updates while the page is hidden.
        logger.debug('SocketManager', `Reduced updates mode: ${enabled}`);
    }

    async initialize(): Promise<void> {
        if (!this.socket) {
            this.initializeSocket();
        }
    }
}

export default SocketManager;
export type { SocketEventHandlers };