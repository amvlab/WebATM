import { modalManager } from './ModalManager';
import { connectionStatus } from '../core/ConnectionStatusService';
import {
    ServerStatus,
    ServerStatusResponse,
    ServerControlResponse
} from '../data/types';
import { logger } from '../utils/Logger';

/**
 * Server Management System
 * Handles BlueSky server control functionality including start/stop/restart operations,
 * status monitoring, and log management
 */
export class ServerManager {
    private socket: any = null;
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

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.initializeElements());
        } else {
            this.initializeElements();
        }
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
     * Set socket connection for real-time updates
     */
    public setSocket(socket: any): void {
        this.socket = socket;
        this.bindSocketHandlers();
    }

    private bindSocketHandlers(): void {
        if (!this.socket) return;

        this.socket.on('server_status_update', (data: ServerStatusResponse) => {
            this.handleStatusUpdate(data);
        });
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

            const data = await response.json();

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
        // Track current server status
        this.currentServerStatus = status;
        
        // Update modal elements
        if (this.elements.statusTextModal) {
            this.elements.statusTextModal.textContent = message;
        }
        
        if (this.elements.statusIndicatorModal) {
            // Remove all status classes
            this.elements.statusIndicatorModal.classList.remove(
                'status-running', 'status-stopped', 'status-unknown', 
                'status-starting', 'status-stopping', 'status-restarting'
            );
            // Add the new status class
            this.elements.statusIndicatorModal.classList.add(`status-${status}`);
        }
        
        // Update button states based on server status
        this.updateButtonStates(status);
        
        // Emit event for server status change
        const event = new CustomEvent('serverStatusUpdate', {
            detail: { status, message }
        });
        document.dispatchEvent(event);
    }

    /**
     * Update button states based on server status (no longer needed)
     */
    private updateButtonStates(_status: ServerStatus): void {
        // No buttons to update - status display only
    }

    /**
     * Handle status update from server response
     */
    private handleStatusUpdate(data: ServerStatusResponse | ServerControlResponse): void {
        if (data.success) {
            let status: ServerStatus = 'unknown';
            
            if ('status' in data && data.status) {
                status = data.status;
            } else {
                // Parse status from message
                const message = data.message || '';
                if (message.includes('running')) status = 'running';
                else if (message.includes('Starting') || message.includes('Restarting')) status = 'starting';
                else if (message.includes('stopped') || message.includes('Stopped')) status = 'stopped';
            }
            
            this.updateStatus(data.message || 'Status updated', status);
        } else {
            this.updateStatus(data.message || 'Unknown error', 'unknown');
        }
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