import { ConnectionStatus, ServerStatus } from '../data/types';

/**
 * Connection Status Management System
 * Handles all connection states including WebATM, BlueSky server, and simulation nodes
 */
export class ConnectionManager {
    private webConnected = false;
    private blueSkyConnected = false;
    private serverStatus: ServerStatus = 'unknown';
    private currentServerIP = 'localhost';
    private nodeInfo: any = null;
    private isInitialized = false;

    // UI Elements
    private elements: {
        connectionStatus: NodeListOf<Element> | null;
        statusIndicators: NodeListOf<Element> | null;
        serverDetails: HTMLElement | null;
        nodeDetails: HTMLElement | null;
    } = {
        connectionStatus: null,
        statusIndicators: null,
        serverDetails: null,
        nodeDetails: null
    };

    constructor() {
        this.init();
    }

    private init(): void {
        if (this.isInitialized) return;

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.initializeElements());
        } else {
            this.initializeElements();
        }
    }

    private initializeElements(): void {
        // Get UI elements for status display
        this.elements.connectionStatus = document.querySelectorAll('.connection-status');
        this.elements.statusIndicators = document.querySelectorAll('.status-indicator');
        this.elements.serverDetails = document.getElementById('server-details');
        this.elements.nodeDetails = document.getElementById('node-details');

        // Setup event listeners
        this.setupEventListeners();

        this.isInitialized = true;
    }

    private setupEventListeners(): void {
        // Listen for custom events from other components
        document.addEventListener('webConnectionUpdate', (e: any) => {
            this.updateWebConnection(e.detail.connected);
        });

        document.addEventListener('blueSkyConnectionUpdate', (e: any) => {
            this.updateBlueSkyConnection(e.detail.connected);
        });

        document.addEventListener('serverStatusUpdate', (e: any) => {
            this.updateServerStatus(e.detail.status, e.detail.message);
        });

        document.addEventListener('nodeInfoUpdate', (e: any) => {
            this.updateNodeInfo(e.detail.nodeInfo);
        });
    }

    /**
     * Update web connection status
     */
    public updateWebConnection(connected: boolean): void {
        this.webConnected = connected;
        this.updateUI();

        // Emit event for other components
        const event = new CustomEvent('connectionStatusChanged', {
            detail: {
                type: 'web',
                connected,
                timestamp: new Date()
            }
        });
        document.dispatchEvent(event);
    }

    /**
     * Update BlueSky server connection status
     */
    public updateBlueSkyConnection(connected: boolean): void {
        this.blueSkyConnected = connected;
        this.updateUI();

        // Emit event for other components
        const event = new CustomEvent('connectionStatusChanged', {
            detail: {
                type: 'bluesky',
                connected,
                timestamp: new Date()
            }
        });
        document.dispatchEvent(event);
    }

    /**
     * Update server status
     */
    public updateServerStatus(status: ServerStatus, message?: string): void {
        this.serverStatus = status;
        this.updateUI();

        // Emit event for other components
        const event = new CustomEvent('connectionStatusChanged', {
            detail: {
                type: 'server',
                status,
                message,
                timestamp: new Date()
            }
        });
        document.dispatchEvent(event);
    }

    /**
     * Update node information
     */
    public updateNodeInfo(nodeInfo: any): void {
        this.nodeInfo = nodeInfo;
        this.updateUI();

        // Emit event for other components
        const event = new CustomEvent('connectionStatusChanged', {
            detail: {
                type: 'nodes',
                nodeInfo,
                timestamp: new Date()
            }
        });
        document.dispatchEvent(event);
    }

    /**
     * Set current server IP
     */
    public setServerIP(ip: string): void {
        this.currentServerIP = ip;
        this.updateUI();
    }

    /**
     * Update all UI elements with current status
     */
    private updateUI(): void {
        this.updateConnectionStatusElements();
        this.updateStatusIndicators();
        this.updateServerDetails();
        this.updateNodeDetails();
    }

    /**
     * Update connection status text elements
     */
    private updateConnectionStatusElements(): void {
        if (!this.elements.connectionStatus) return;

        this.elements.connectionStatus.forEach(element => {
            let statusText = 'Disconnected';
            let statusClass = 'disconnected';

            if (this.webConnected && this.blueSkyConnected) {
                statusText = 'Connected';
                statusClass = 'connected';
            } else if (this.webConnected) {
                statusText = 'Web Connected';
                statusClass = 'partial';
            }

            element.textContent = statusText;
            element.className = `connection-status ${statusClass}`;
        });
    }

    /**
     * Update status indicator elements (lights, dots, etc.)
     */
    private updateStatusIndicators(): void {
        if (!this.elements.statusIndicators) return;

        this.elements.statusIndicators.forEach(indicator => {
            // Remove all status classes
            indicator.classList.remove('connected', 'disconnected', 'partial', 'error');

            // Add appropriate class based on connection state
            if (this.webConnected && this.blueSkyConnected) {
                indicator.classList.add('connected');
            } else if (this.webConnected) {
                indicator.classList.add('partial');
            } else {
                indicator.classList.add('disconnected');
            }
        });
    }

    /**
     * Update server details display
     */
    private updateServerDetails(): void {
        if (!this.elements.serverDetails) return;

        const serverInfo = {
            ip: this.currentServerIP,
            status: this.serverStatus,
            connected: this.blueSkyConnected
        };

        this.elements.serverDetails.innerHTML = `
            <div class="server-info">
                <span class="server-label">Server:</span>
                <span class="server-ip">${serverInfo.ip}</span>
                <span class="server-status status-${serverInfo.status}">${serverInfo.status}</span>
            </div>
        `;

        // Update color based on connection status
        if (serverInfo.connected) {
            this.elements.serverDetails.style.color = '#4caf50'; // Green
        } else {
            this.elements.serverDetails.style.color = '#f44336'; // Red
        }
    }

    /**
     * Update node details display
     */
    private updateNodeDetails(): void {
        if (!this.elements.nodeDetails || !this.nodeInfo) return;

        const nodeCount = this.nodeInfo.total_nodes || 0;
        const activeNode = this.nodeInfo.active_node || 'None';

        this.elements.nodeDetails.innerHTML = `
            <div class="node-info">
                <span class="node-label">Nodes:</span>
                <span class="node-count">${nodeCount}</span>
                <span class="active-node">Active: ${activeNode}</span>
            </div>
        `;
    }

    /**
     * Get current connection status
     */
    public getConnectionStatus(): ConnectionStatus {
        return {
            connected: this.webConnected && this.blueSkyConnected,
            server: this.currentServerIP,
            timestamp: Date.now()
        };
    }

    /**
     * Get detailed status information
     */
    public getDetailedStatus() {
        return {
            web: this.webConnected,
            bluesky: this.blueSkyConnected,
            server: {
                ip: this.currentServerIP,
                status: this.serverStatus
            },
            nodes: this.nodeInfo
        };
    }

    /**
     * Check if fully connected (web + BlueSky)
     */
    public isFullyConnected(): boolean {
        return this.webConnected && this.blueSkyConnected;
    }

    /**
     * Check if web is connected
     */
    public isWebConnected(): boolean {
        return this.webConnected;
    }

    /**
     * Check if BlueSky is connected
     */
    public isBlueSkyConnected(): boolean {
        return this.blueSkyConnected;
    }

    /**
     * Get current server status
     */
    public getServerStatus(): ServerStatus {
        return this.serverStatus;
    }

    /**
     * Get current server IP
     */
    public getServerIP(): string {
        return this.currentServerIP;
    }

    /**
     * Reset all connections
     */
    public reset(): void {
        this.webConnected = false;
        this.blueSkyConnected = false;
        this.serverStatus = 'unknown';
        this.nodeInfo = null;
        this.updateUI();
    }

    /**
     * Check if connection manager is initialized
     */
    public isReady(): boolean {
        return this.isInitialized;
    }
}

// Export singleton instance
export const connectionManager = new ConnectionManager();