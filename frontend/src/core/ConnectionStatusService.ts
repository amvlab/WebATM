/**
 * Centralized singleton service holding every connection state: the WebSocket
 * to the WebATM server, the BlueSky server connection, and data reception.
 *
 * Key concept: receiving any server data (nodeinfo, siminfo, acdata, shapes)
 * proves the BlueSky connection is up. If nothing arrives for DATA_TIMEOUT_MS,
 * the connection is considered lost.
 */

import { echoManager } from '../ui/EchoManager';
import { logger } from '../utils/Logger';
import { EventEmitter } from '../utils/events';

export interface ConnectionStatusData {
    // WebSocket connection to WebATM
    webSocketConnected: boolean;

    // BlueSky server connection (derived from receiving data)
    blueSkyConnected: boolean;

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
 * Single source of truth for all connection states.
 */
export class ConnectionStatusService {
    private static instance: ConnectionStatusService | null = null;

    private status: ConnectionStatusData = {
        webSocketConnected: false,
        blueSkyConnected: false,
        receivingData: false,
        lastDataReceived: null,
        lastNodeInfoReceived: null,
        serverIP: 'localhost',
        nodeInfoInterval: null
    };

    private statusEmitter = new EventEmitter<ConnectionStatusData>('ConnectionStatus');
    private dataTimeoutId: number | null = null;
    private readonly DATA_TIMEOUT_MS = 5000; // Consider disconnected if no data for 5 seconds

    // A setTimeout that fires far past its delay means the event loop was
    // blocked (heavy synchronous work, GC pause, backgrounded tab). During
    // that window the socket couldn't deliver data anyway, so "no data" is
    // not evidence of a real disconnect - we defer (bounded) and let live
    // data confirm the connection instead of flashing a false disconnect.
    private dataTimeoutArmedAt = 0;
    private stallDeferrals = 0;
    private readonly MAX_STALL_DEFERRALS = 2;
    private readonly STALL_OVERSHOOT_MS = 1500;

    // End of the deliberate-disconnect grace window (see expectDisconnect).
    private ignoreDataUntil = 0;

    // Initial connection tracking
    private isInitialLoadComplete: boolean = false;
    private initialConnectionCheckTimer: number | null = null;
    private readonly INITIAL_CONNECTION_CHECK_DELAY_MS = 500;

    // Connection event callbacks
    private blueSkyDisconnectEmitter = new EventEmitter<boolean>('ConnectionStatus.disconnect');

    private constructor() {
        // Private constructor for singleton. The data timeout that
        // detects disconnection is armed when the first data arrives.
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
        const unsubscribe = this.statusEmitter.subscribe(listener);

        // Immediately call listener with current status, with the same
        // error isolation the emitter applies on later updates.
        try {
            listener(this.getStatus());
        } catch (error) {
            logger.error('ConnectionStatus', 'Error in connection status listener:', error);
        }

        return unsubscribe;
    }

    private notifyListeners(): void {
        this.statusEmitter.emit(this.getStatus());
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

        if (changed) {
            logger.info('ConnectionStatus', `WebSocket: ${connected ? 'connected' : 'disconnected'}`);

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

    // ========================================
    // BlueSky Server Connection Methods
    // ========================================

    /**
     * Update BlueSky server connection status.
     * Called when data is received, or when the connection is known to be
     * down (explicit disconnect, server_disconnected, WebSocket drop).
     */
    public setBlueSkyConnected(connected: boolean): void {
        const changed = this.status.blueSkyConnected !== connected;
        const wasConnected = this.status.blueSkyConnected;

        this.status.blueSkyConnected = connected;

        if (!connected) {
            // The connection is known to be down: the pending no-data timer
            // is now meaningless. Without this it fires up to DATA_TIMEOUT_MS
            // later and echoes a false "no data received" warning after a
            // deliberate disconnect (e.g. QUIT), and receivingData would
            // stay stale after a WebSocket drop.
            this.clearDataTimeout();
            this.stallDeferrals = 0;
            this.setReceivingData(false);
        }

        if (changed) {
            logger.info('ConnectionStatus', `BlueSky: ${connected ? 'connected' : 'disconnected'}`);

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
     * A deliberate disconnect (QUIT, server_disconnected) is happening: data
     * events already in flight would otherwise flip the status straight back
     * to connected and re-arm the no-data timer, which then fires a spurious
     * "connection may be lost" warning 5s after a clean disconnect. Ignore
     * data for a short grace window; data still flowing after it (e.g. the
     * disconnect request failed) reconnects as usual.
     */
    public expectDisconnect(graceMs: number = 2000): void {
        this.ignoreDataUntil = Date.now() + graceMs;
    }

    /**
     * True while the deliberate-disconnect grace window is open. Lets data
     * consumers (e.g. SocketManager) drop in-flight frames that would
     * repaint the traffic the disconnect just cleared.
     */
    public isInDisconnectGrace(): boolean {
        return Date.now() < this.ignoreDataUntil;
    }

    /**
     * Shared handling for every server data event: receiving anything
     * proves the BlueSky connection is up and resets the disconnect
     * timeout. Data-bearing events (siminfo/acdata) additionally flip
     * the receivingData flag.
     */
    private onServerDataReceived(kind: string, marksReceivingData: boolean): void {
        if (Date.now() < this.ignoreDataUntil) {
            logger.debug('ConnectionStatus', `${kind} ignored - disconnect grace window`);
            return;
        }
        logger.debug('ConnectionStatus', `${kind} received`);

        if (!this.status.blueSkyConnected) {
            logger.info('ConnectionStatus', `Setting BlueSky connected (via ${kind})`);
            this.setBlueSkyConnected(true);
        }

        if (marksReceivingData && !this.status.receivingData) {
            this.setReceivingData(true);
        }

        // Reset the timeout for detecting disconnection (any data type resets it)
        this.resetDataTimeout();
    }

    /**
     * Called when nodeinfo is received
     */
    public onNodeInfoReceived(): void {
        const now = Date.now();

        if (this.status.lastNodeInfoReceived !== null) {
            this.status.nodeInfoInterval = now - this.status.lastNodeInfoReceived;
        }
        this.status.lastNodeInfoReceived = now;

        this.onServerDataReceived('node info', false);
    }

    /**
     * Called when simulation info (siminfo) is received
     */
    public onSimInfoReceived(): void {
        this.status.lastDataReceived = Date.now();
        this.onServerDataReceived('simulation info', true);
    }

    /**
     * Called when aircraft data (acdata) is received
     */
    public onAircraftDataReceived(): void {
        this.status.lastDataReceived = Date.now();
        this.onServerDataReceived('aircraft data', true);
    }

    /**
     * Called when shape data (poly/polyline) is received
     */
    public onShapeDataReceived(): void {
        this.status.lastDataReceived = Date.now();
        this.onServerDataReceived('shape data', false);
    }

    /**
     * Reset the timeout that detects when we stop receiving any data
     */
    private resetDataTimeout(): void {
        // Fresh data clears any stall-deferral budget and re-arms the timer.
        this.stallDeferrals = 0;
        this.armDataTimeout();
    }

    /** (Re)arm the no-data timeout, recording when it was armed. */
    private armDataTimeout(): void {
        this.clearDataTimeout();
        this.dataTimeoutArmedAt = Date.now();
        this.dataTimeoutId = window.setTimeout(
            () => this.onDataTimeoutExpired(),
            this.DATA_TIMEOUT_MS
        );
    }

    /** Cancel the pending no-data timeout, if any. */
    private clearDataTimeout(): void {
        if (this.dataTimeoutId !== null) {
            window.clearTimeout(this.dataTimeoutId);
            this.dataTimeoutId = null;
        }
    }

    /**
     * Called when the no-data timeout fires. A callback that ran far later
     * than its scheduled delay means the page was frozen, so the silence is
     * a local stall rather than a server outage: defer the disconnect and
     * re-arm (bounded by MAX_STALL_DEFERRALS). Otherwise treat the silence
     * as a real disconnect.
     */
    private onDataTimeoutExpired(): void {
        this.dataTimeoutId = null;
        const overshoot = Date.now() - this.dataTimeoutArmedAt - this.DATA_TIMEOUT_MS;

        if (overshoot > this.STALL_OVERSHOOT_MS && this.stallDeferrals < this.MAX_STALL_DEFERRALS) {
            this.stallDeferrals++;
            logger.warn(
                'ConnectionStatus',
                `Data timeout fired ${Math.round(overshoot)}ms late - main thread stalled; ` +
                    `deferring disconnect (${this.stallDeferrals}/${this.MAX_STALL_DEFERRALS})`
            );
            this.armDataTimeout();
            return;
        }

        this.stallDeferrals = 0;
        if (this.status.blueSkyConnected) {
            logger.warn('ConnectionStatus', 'No data received (nodeinfo, siminfo, or acdata) - BlueSky may be disconnected');
            echoManager.warning('⚠ No data received from BlueSky server - connection may be lost');
            this.setBlueSkyConnected(false);
        }
    }

    // ========================================
    // Data Reception Methods
    // ========================================

    /**
     * Update data reception status
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

        return this.status.receivingData
            ? `Connected to BlueSky server at ${this.status.serverIP}.`
            : `Connected to BlueSky server at ${this.status.serverIP} (No Data).`;
    }

    /**
     * Reset all connection states (but preserve server IP)
     */
    public reset(): void {
        const serverIP = this.status.serverIP;

        this.status = {
            webSocketConnected: false,
            blueSkyConnected: false,
            receivingData: false,
            lastDataReceived: null,
            lastNodeInfoReceived: null,
            serverIP: serverIP,
            nodeInfoInterval: null
        };

        this.clearDataTimeout();
        this.stallDeferrals = 0;
        this.dataTimeoutArmedAt = 0;
        this.ignoreDataUntil = 0;

        logger.info('ConnectionStatus', 'Reset all connection states');
        this.notifyListeners();
    }

    /**
     * Get detailed status for debugging (window.connectionStatus helper)
     */
    public getDetailedStatus(): string {
        const status = this.getStatus();
        return JSON.stringify({
            webSocket: { connected: status.webSocketConnected },
            blueSky: {
                connected: status.blueSkyConnected,
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

    private loadInitialLoadState(): void {
        this.isInitialLoadComplete = sessionStorage.getItem('bluesky-initial-load-complete') === 'true';
    }

    /**
     * On the first page load of a session, invoke onNotConnected if no
     * BlueSky connection is established shortly after startup.
     */
    public startInitialConnectionCheck(onNotConnected: () => void): void {
        if (this.isInitialLoadComplete) {
            logger.debug('ConnectionStatus', 'Not initial page load - skipping auto-check');
            return;
        }

        this.markInitialLoadComplete();

        if (this.status.blueSkyConnected) {
            logger.info('ConnectionStatus', 'Initial load: Already connected to BlueSky server');
            return;
        }

        // Give the connection a moment to establish before prompting.
        this.initialConnectionCheckTimer = window.setTimeout(() => {
            this.initialConnectionCheckTimer = null;
            if (!this.status.blueSkyConnected) {
                logger.info('ConnectionStatus', 'Initial load: Not connected to BlueSky server');
                onNotConnected();
            }
        }, this.INITIAL_CONNECTION_CHECK_DELAY_MS);

        // Cancel the pending prompt as soon as a connection is confirmed.
        // subscribe() invokes the listener synchronously, but the early return
        // above guarantees that first call sees blueSkyConnected === false, so
        // `unsubscribe` is never read before it is assigned.
        const unsubscribe = this.subscribe((status) => {
            if (!status.blueSkyConnected) {
                return;
            }
            if (this.initialConnectionCheckTimer !== null) {
                window.clearTimeout(this.initialConnectionCheckTimer);
                this.initialConnectionCheckTimer = null;
                logger.info('ConnectionStatus', 'BlueSky connected during initial load');
            }
            unsubscribe();
        });
    }

    private markInitialLoadComplete(): void {
        this.isInitialLoadComplete = true;
        sessionStorage.setItem('bluesky-initial-load-complete', 'true');
    }

    // ========================================
    // Connection Event Callbacks
    // ========================================

    /**
     * Register callback for BlueSky disconnection events
     * Returns unsubscribe function
     */
    public onBlueSkyDisconnect(callback: ConnectionEventCallback): () => void {
        return this.blueSkyDisconnectEmitter.subscribe(callback);
    }

    private triggerDisconnectCallbacks(): void {
        logger.debug('ConnectionStatus', 'Triggering disconnect callbacks');
        this.blueSkyDisconnectEmitter.emit(false);
    }
}

// Export singleton instance
export const connectionStatus = ConnectionStatusService.getInstance();
