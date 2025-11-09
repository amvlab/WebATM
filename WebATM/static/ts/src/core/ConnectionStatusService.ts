/**
 * Connection Status Service
 *
 * Centralized singleton service for managing all connection states in the application.
 * This service tracks:
 * - WebSocket connection to WebATM server
 * - BlueSky server connection status (derived from receiving data)
 * - Data reception status
 *
 * The connection status should be available across all TypeScript classes.
 *
 * Key concept: As long as we're receiving any data (nodeinfo, siminfo, or acdata),
 * we're connected to BlueSky server. If no data is received for DATA_TIMEOUT_MS,
 * the connection is considered lost.
 */

import { echoManager } from '../ui/EchoManager';
import { logger } from '../utils/Logger';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectionStatusData {
    // WebSocket connection to WebATM
    webSocketConnected: boolean;
    webSocketState: ConnectionState;

    // BlueSky server connection (determined by nodeinfo receipt)
    blueSkyConnected: boolean;
    blueSkyState: ConnectionState;

    // Data flow indicators
    receivingData: boolean;
    lastDataReceived: number | null;  // timestamp
    lastNodeInfoReceived: number | null;  // timestamp

    // Server details
    serverIP: string;

    // Connection quality
    nodeInfoInterval: number | null;  // ms between nodeinfo messages
}

type ConnectionStatusListener = (status: ConnectionStatusData) => void;
type ConnectionEventCallback = (connected: boolean) => void;

/**
 * Centralized Connection Status Service
 *
 * This service maintains the single source of truth for all connection states.
 */
export class ConnectionStatusService {
    private static instance: ConnectionStatusService | null = null;

    private status: ConnectionStatusData = {
        webSocketConnected: false,
        webSocketState: 'disconnected',
        blueSkyConnected: false,
        blueSkyState: 'disconnected',
        receivingData: false,
        lastDataReceived: null,
        lastNodeInfoReceived: null,
        serverIP: 'localhost',
        nodeInfoInterval: null
    };

    private listeners: Set<ConnectionStatusListener> = new Set();
    private dataTimeoutId: number | null = null;
    private readonly DATA_TIMEOUT_MS = 5000; // Consider disconnected if no data for 5 seconds

    // Initial connection tracking
    private isInitialLoadComplete: boolean = false;
    private initialConnectionCheckTimer: number | null = null;
    private readonly INITIAL_CONNECTION_CHECK_DELAY_MS = 500; // Wait 0.5s before checking initial connection

    // Connection event callbacks
    private onBlueSkyDisconnectCallbacks: Set<ConnectionEventCallback> = new Set();

    private constructor() {
        // Private constructor for singleton
        this.startDataMonitoring();
        this.loadInitialLoadState();
    }

    /**
     * Get singleton instance
     */
    public static getInstance(): ConnectionStatusService {
        if (!ConnectionStatusService.instance) {
            ConnectionStatusService.instance = new ConnectionStatusService();
        }
        return ConnectionStatusService.instance;
    }

    /**
     * Subscribe to connection status changes
     * Returns unsubscribe function
     */
    public subscribe(listener: ConnectionStatusListener): () => void {
        this.listeners.add(listener);

        // Immediately call listener with current status
        listener(this.getStatus());

        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Notify all listeners of status change
     */
    private notifyListeners(): void {
        const currentStatus = this.getStatus();
        this.listeners.forEach(listener => {
            try {
                listener(currentStatus);
            } catch (error) {
                logger.error('ConnectionStatus', 'Error in connection status listener:', error);
            }
        });
    }

    /**
     * Get current connection status (immutable copy)
     */
    public getStatus(): Readonly<ConnectionStatusData> {
        return { ...this.status };
    }

    // ========================================
    // WebSocket Connection Methods
    // ========================================

    /**
     * Update WebSocket connection status
     */
    public setWebSocketConnected(connected: boolean): void {
        const changed = this.status.webSocketConnected !== connected;
        this.status.webSocketConnected = connected;
        this.status.webSocketState = connected ? 'connected' : 'disconnected';

        if (changed) {
            logger.info('ConnectionStatus', `WebSocket: ${connected ? 'connected' : 'disconnected'}`);

            // Log to echo messages
            if (connected) {
                echoManager.success('Connected to WebATM server');
            } else {
                echoManager.error('✗ Disconnected from WebATM server');
            }

            this.notifyListeners();
        }

        // If WebSocket disconnects, BlueSky is also disconnected
        if (!connected) {
            this.setBlueSkyConnected(false);
        }
    }

    /**
     * Set WebSocket to connecting state
     */
    public setWebSocketConnecting(): void {
        this.status.webSocketState = 'connecting';
        echoManager.info('⟳ Connecting to WebATM server...');
        this.notifyListeners();
    }

    /**
     * Set WebSocket to error state
     */
    public setWebSocketError(): void {
        this.status.webSocketState = 'error';
        this.status.webSocketConnected = false;
        echoManager.error('✗ WebATM server connection error');
        this.notifyListeners();
    }

    // ========================================
    // BlueSky Server Connection Methods
    // ========================================

    /**
     * Update BlueSky server connection status
     * This should be called when nodeinfo is received or connection is explicitly lost
     */
    public setBlueSkyConnected(connected: boolean): void {
        const changed = this.status.blueSkyConnected !== connected;
        const wasConnected = this.status.blueSkyConnected;

        this.status.blueSkyConnected = connected;
        this.status.blueSkyState = connected ? 'connected' : 'disconnected';

        if (changed) {
            logger.info('ConnectionStatus', `BlueSky: ${connected ? 'connected' : 'disconnected'}`);

            // Log to echo messages
            if (connected) {
                echoManager.success('Connected to BlueSky server');
            } else {
                echoManager.warning('✗ Disconnected from BlueSky server');
            }

            this.notifyListeners();

            // If we just disconnected (was connected, now not), trigger disconnect callbacks
            if (wasConnected && !connected && this.isInitialLoadComplete) {
                this.triggerDisconnectCallbacks();
            }
        }
    }

    /**
     * Set BlueSky to connecting state
     */
    public setBlueSkyConnecting(): void {
        this.status.blueSkyState = 'connecting';
        echoManager.info('⟳ Connecting to BlueSky server...');
        this.notifyListeners();
    }

    /**
     * Called when nodeinfo is received
     * This is an indicator that we're connected to BlueSky server
     */
    public onNodeInfoReceived(): void {
        const now = Date.now();

        // Calculate interval between nodeinfo messages
        if (this.status.lastNodeInfoReceived !== null) {
            this.status.nodeInfoInterval = now - this.status.lastNodeInfoReceived;
        }

        this.status.lastNodeInfoReceived = now;

        // Log nodeinfo reception
        logger.debug('ConnectionStatus', 'Node info received');

        // If we're receiving nodeinfo, we're definitely connected
        if (!this.status.blueSkyConnected) {
            logger.info('ConnectionStatus', 'Setting BlueSky connected (via nodeinfo)');
            this.setBlueSkyConnected(true);
        }

        // Reset the timeout for detecting disconnection (any data type resets this)
        this.resetDataTimeout();
    }

    /**
     * Called when simulation info (siminfo) is received
     * This is a strong indicator that we're connected and receiving data
     */
    public onSimInfoReceived(): void {
        const now = Date.now();
        this.status.lastDataReceived = now;

        // Log siminfo reception
        logger.debug('ConnectionStatus', 'Simulation info received');

        // If we're receiving siminfo, we're connected and receiving data
        if (!this.status.blueSkyConnected) {
            logger.info('ConnectionStatus', 'Setting BlueSky connected (via siminfo)');
            this.setBlueSkyConnected(true);
        }

        // Mark as receiving data
        if (!this.status.receivingData) {
            this.setReceivingData(true);
        }

        // Reset the timeout for detecting disconnection
        this.resetDataTimeout();
    }

    /**
     * Called when aircraft data (acdata) is received
     * This is a strong indicator that we're connected and receiving data
     */
    public onAircraftDataReceived(): void {
        const now = Date.now();
        this.status.lastDataReceived = now;

        // Log aircraft data reception
        logger.debug('ConnectionStatus', 'Aircraft data received');

        // If we're receiving aircraft data, we're connected and receiving data
        if (!this.status.blueSkyConnected) {
            logger.info('ConnectionStatus', 'Setting BlueSky connected (via aircraft data)');
            this.setBlueSkyConnected(true);
        }

        // Mark as receiving data
        if (!this.status.receivingData) {
            this.setReceivingData(true);
        }

        // Reset the timeout for detecting disconnection
        this.resetDataTimeout();
    }

    /**
     * Called when shape data (poly/polyline) is received
     * This is an indicator that we're connected to BlueSky server
     */
    public onShapeDataReceived(): void {
        const now = Date.now();
        this.status.lastDataReceived = now;

        // Log shape data reception
        logger.debug('ConnectionStatus', 'Shape data received');

        // If we're receiving shape data, we're connected to BlueSky
        if (!this.status.blueSkyConnected) {
            logger.info('ConnectionStatus', 'Setting BlueSky connected (via shape data)');
            this.setBlueSkyConnected(true);
        }

        // Reset the timeout for detecting disconnection
        this.resetDataTimeout();
    }

    /**
     * Monitor data reception to detect disconnection
     */
    private startDataMonitoring(): void {
        // This will be set up when first data is received
    }

    /**
     * Reset the timeout that detects when we stop receiving any data
     * This is called when we receive nodeinfo, siminfo, or acdata
     */
    private resetDataTimeout(): void {
        if (this.dataTimeoutId !== null) {
            window.clearTimeout(this.dataTimeoutId);
        }

        this.dataTimeoutId = window.setTimeout(() => {
            // No data received for DATA_TIMEOUT_MS
            logger.warn('ConnectionStatus', 'No data received (nodeinfo, siminfo, or acdata) - BlueSky may be disconnected');
            echoManager.warning('⚠ No data received from BlueSky server - connection may be lost');
            if (this.status.blueSkyConnected) {
                this.setBlueSkyConnected(false);
                this.setReceivingData(false);
            }
        }, this.DATA_TIMEOUT_MS);
    }

    // ========================================
    // Data Reception Methods
    // ========================================

    /**
     * Update data reception status
     * Called when simulation data (siminfo, acdata) is received
     */
    public setReceivingData(receiving: boolean): void {
        const changed = this.status.receivingData !== receiving;
        this.status.receivingData = receiving;

        if (receiving) {
            this.status.lastDataReceived = Date.now();
        }

        if (changed) {
            logger.debug('ConnectionStatus', `Receiving data: ${receiving}`);
            this.notifyListeners();
        }
    }

    /**
     * Called when any simulation data is received
     */
    public onDataReceived(): void {
        this.status.lastDataReceived = Date.now();

        if (!this.status.receivingData) {
            this.setReceivingData(true);
        }
    }

    // ========================================
    // Server Configuration Methods
    // ========================================

    /**
     * Set server IP address
     */
    public setServerIP(ip: string): void {
        if (this.status.serverIP !== ip) {
            this.status.serverIP = ip;
            logger.info('ConnectionStatus', `Server IP: ${ip}`);
            this.notifyListeners();
        }
    }

    // ========================================
    // Utility Methods
    // ========================================

    /**
     * Check if fully connected (WebSocket + BlueSky)
     */
    public isFullyConnected(): boolean {
        return this.status.webSocketConnected && this.status.blueSkyConnected;
    }

    /**
     * Check if WebSocket is connected
     */
    public isWebSocketConnected(): boolean {
        return this.status.webSocketConnected;
    }

    /**
     * Check if BlueSky is connected
     */
    public isBlueSkyConnected(): boolean {
        return this.status.blueSkyConnected;
    }

    /**
     * Check if receiving data
     */
    public isReceivingData(): boolean {
        return this.status.receivingData;
    }

    /**
     * Get connection quality metric (based on nodeinfo interval)
     */
    public getConnectionQuality(): 'excellent' | 'good' | 'poor' | 'unknown' {
        if (this.status.nodeInfoInterval === null) {
            return 'unknown';
        }

        if (this.status.nodeInfoInterval < 1000) {
            return 'excellent';
        } else if (this.status.nodeInfoInterval < 2000) {
            return 'good';
        } else {
            return 'poor';
        }
    }

    /**
     * Get human-readable connection status string
     */
    public getStatusString(): string {
        if (!this.status.webSocketConnected) {
            return 'Disconnected from WebATM server';
        }

        if (!this.status.blueSkyConnected) {
            return 'Disconnected from BlueSky server. Please visit settings and make sure that (1) BlueSky server has been started and (2) You are connected to server.';
        }

        if (this.status.blueSkyConnected && this.status.receivingData) {
            return `Connected to BlueSky server at ${this.status.serverIP}.`;
        }

        if (this.status.blueSkyConnected && !this.status.receivingData) {
            return `Connected to BlueSky server at ${this.status.serverIP} (No Data).`;
        }

        return 'Unknown connection status';
    }

    /**
     * Reset all connection states (but preserve server IP)
     */
    public reset(): void {
        const serverIP = this.status.serverIP;

        this.status = {
            webSocketConnected: false,
            webSocketState: 'disconnected',
            blueSkyConnected: false,
            blueSkyState: 'disconnected',
            receivingData: false,
            lastDataReceived: null,
            lastNodeInfoReceived: null,
            serverIP: serverIP,
            nodeInfoInterval: null
        };

        if (this.dataTimeoutId !== null) {
            window.clearTimeout(this.dataTimeoutId);
            this.dataTimeoutId = null;
        }

        logger.info('ConnectionStatus', 'Reset all connection states');
        this.notifyListeners();
    }

    /**
     * Get detailed status for debugging
     */
    public getDetailedStatus(): string {
        const status = this.getStatus();
        return JSON.stringify({
            webSocket: {
                connected: status.webSocketConnected,
                state: status.webSocketState
            },
            blueSky: {
                connected: status.blueSkyConnected,
                state: status.blueSkyState,
                lastNodeInfo: status.lastNodeInfoReceived ?
                    `${Date.now() - status.lastNodeInfoReceived}ms ago` : 'never',
                interval: status.nodeInfoInterval ? `${status.nodeInfoInterval}ms` : 'unknown'
            },
            data: {
                receiving: status.receivingData,
                lastReceived: status.lastDataReceived ?
                    `${Date.now() - status.lastDataReceived}ms ago` : 'never'
            },
            server: status.serverIP,
            quality: this.getConnectionQuality(),
            initialLoadComplete: this.isInitialLoadComplete
        }, null, 2);
    }

    // ========================================
    // Initial Connection Checking Methods
    // ========================================

    /**
     * Load initial load state from sessionStorage
     */
    private loadInitialLoadState(): void {
        this.isInitialLoadComplete = sessionStorage.getItem('bluesky-initial-load-complete') === 'true';
    }

    /**
     * Start initial connection check
     * This checks if we're connected after a delay on first page load
     */
    public startInitialConnectionCheck(onNotConnected: () => void): void {
        if (this.isInitialLoadComplete) {
            logger.debug('ConnectionStatus', 'Not initial page load - skipping auto-check');
            return;
        }

        // Mark that we've started the initial load check
        this.markInitialLoadComplete();

        // Wait for connection to establish
        this.initialConnectionCheckTimer = window.setTimeout(() => {
            if (!this.status.blueSkyConnected) {
                logger.info('ConnectionStatus', 'Initial load: Not connected to BlueSky server');
                onNotConnected();
            } else {
                logger.info('ConnectionStatus', 'Initial load: Already connected to BlueSky server');
            }
        }, this.INITIAL_CONNECTION_CHECK_DELAY_MS);

        // Also listen for early connection
        const checkConnection = () => {
            if (this.status.blueSkyConnected && this.initialConnectionCheckTimer !== null) {
                window.clearTimeout(this.initialConnectionCheckTimer);
                this.initialConnectionCheckTimer = null;
                logger.info('ConnectionStatus', 'BlueSky connected during initial load');
            }
        };

        // Subscribe to status changes for early connection detection
        const unsubscribe = this.subscribe((status) => {
            if (status.blueSkyConnected) {
                checkConnection();
                unsubscribe();
            }
        });
    }

    /**
     * Mark initial load as complete
     */
    private markInitialLoadComplete(): void {
        this.isInitialLoadComplete = true;
        sessionStorage.setItem('bluesky-initial-load-complete', 'true');
    }

    /**
     * Check if initial load is complete
     */
    public isInitialLoad(): boolean {
        return !this.isInitialLoadComplete;
    }

    // ========================================
    // Connection Event Callbacks
    // ========================================

    /**
     * Register callback for BlueSky disconnection events
     * Returns unsubscribe function
     */
    public onBlueSkyDisconnect(callback: ConnectionEventCallback): () => void {
        this.onBlueSkyDisconnectCallbacks.add(callback);

        return () => {
            this.onBlueSkyDisconnectCallbacks.delete(callback);
        };
    }

    /**
     * Trigger all disconnect callbacks
     */
    private triggerDisconnectCallbacks(): void {
        logger.debug('ConnectionStatus', 'Triggering disconnect callbacks');
        this.onBlueSkyDisconnectCallbacks.forEach(callback => {
            try {
                callback(false);
            } catch (error) {
                logger.error('ConnectionStatus', 'Error in disconnect callback:', error);
            }
        });
    }
}

// Export singleton instance
export const connectionStatus = ConnectionStatusService.getInstance();
