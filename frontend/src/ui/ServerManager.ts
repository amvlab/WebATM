import { connectionStatus } from '../core/ConnectionStatusService';
import { ServerStatus, ServerStatusResponse } from '../data/types';
import { logger } from '../utils/Logger';
import { onDOMReady } from '../utils/dom';
import { StatusDisplayManager } from './StatusDisplayManager';

/**
 * Server Management System
 * Handles BlueSky server control functionality including start/stop/restart operations,
 * status monitoring, and log management
 */
export class ServerManager {
    private statusCheckInterval: number | null = null;
    private currentServerStatus: ServerStatus = 'unknown';
    private isInitialized = false;
    private isConnectedToBlueSky = false;

    // Element references
    private elements: {
        // Status elements
        statusTextModal: HTMLElement | null;
        statusIndicatorModal: HTMLElement | null;
    } = {
        statusTextModal: null,
        statusIndicatorModal: null
    };

    constructor() {
        logger.debug('ServerManager', 'Constructor called');
        this.init();
    }

    private init(): void {
        if (this.isInitialized) return;
        onDOMReady(() => this.initializeElements());
    }

    private initializeElements(): void {
        logger.debug('ServerManager', 'initializeElements called');
        // Get status element references only
        this.elements.statusTextModal = document.getElementById('server-status-text-modal');
        this.elements.statusIndicatorModal = document.getElementById('server-status-indicator-modal');

        // Subscribe to connection status changes
        connectionStatus.subscribe((status) => {
            const wasConnected = this.isConnectedToBlueSky;
            this.isConnectedToBlueSky = status.blueSkyConnected;

            // Start or stop periodic checks based on connection status
            if (this.isConnectedToBlueSky && !wasConnected) {
                logger.info('ServerManager', 'BlueSky connected - starting periodic status checks');
                this.startStatusChecking();
            } else if (!this.isConnectedToBlueSky && wasConnected) {
                logger.info('ServerManager', 'BlueSky disconnected - stopping periodic status checks');
                this.stopStatusChecking();
            }
        });

        // Do an initial check regardless of connection state
        this.checkServerStatus();

        this.isInitialized = true;
    }


    /**
     * Check current server status
     * @param hostname Optional hostname to check (defaults to current server)
     */
    public async checkServerStatus(hostname?: string): Promise<void> {
        try {
            let response;

            if (hostname) {
                // Check specific hostname via POST
                response = await fetch('/api/server/status', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ hostname })
                });
            } else {
                // Check current server via GET
                response = await fetch('/api/server/status');
            }

            const data: ServerStatusResponse = await response.json();

            if (data.status === 'success') {
                const status: ServerStatus = data.running ? 'running' : 'stopped';
                this.updateStatus(data.message, status);
            } else {
                this.updateStatus('Error checking status', 'unknown');
            }
        } catch (error) {
            logger.error('ServerManager', 'Error checking server status:', error);
            this.updateStatus('Connection error', 'unknown');
        }
    }

    /**
     * Start periodic status checking
     * Only starts if connected to BlueSky
     */
    private startStatusChecking(): void {
        // Stop any existing interval first
        this.stopStatusChecking();

        // Only start periodic checks if connected to BlueSky
        if (!this.isConnectedToBlueSky) {
            logger.debug('ServerManager', 'Not starting periodic checks - not connected to BlueSky');
            return;
        }

        logger.debug('ServerManager', 'Starting periodic status checks (every 10 seconds)');

        // Check status immediately
        this.checkServerStatus();

        // Then check every 10 seconds
        this.statusCheckInterval = window.setInterval(() => {
            this.checkServerStatus();
        }, 10000);
    }

    /**
     * Stop periodic status checking
     */
    private stopStatusChecking(): void {
        if (this.statusCheckInterval !== null) {
            logger.debug('ServerManager', 'Stopping periodic status checks');
            clearInterval(this.statusCheckInterval);
            this.statusCheckInterval = null;
        }
    }

    /**
     * Update server status display
     */
    private updateStatus(message: string, status: ServerStatus): void {
        this.currentServerStatus = status;

        new StatusDisplayManager(
            this.elements.statusTextModal,
            this.elements.statusIndicatorModal
        ).update(message, status);

        const event = new CustomEvent('serverStatusUpdate', {
            detail: { status, message }
        });
        document.dispatchEvent(event);
    }

    /**
     * Get current server status for external components
     */
    public getServerStatus(): ServerStatus {
        return this.currentServerStatus;
    }

    /**
     * Reset server status display to initial state
     * Used when disconnecting to clear old status
     */
    public resetStatus(): void {
        this.updateStatus('Click "Check Status"', 'unknown');
        logger.debug('ServerManager', 'Server status reset to initial state');
    }

    /**
     * Cleanup resources
     */
    public destroy(): void {
        this.stopStatusChecking();
    }
}

// Export singleton instance
export const serverManager = new ServerManager();