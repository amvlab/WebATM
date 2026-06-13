import { SocketManager } from '../core/SocketManager';
import { StateManager } from '../core/StateManager';
import { ServerStatus } from '../data/types';
import { logger } from '../utils/Logger';
import { StatusDisplayManager } from './StatusDisplayManager';

/**
 * Server response data structure
 */
export interface ServerResponse {
    status: 'success' | 'error';
    message: string;
    running?: boolean;
}

/**
 * Controls class manages all UI control elements and their interactions
 * Includes simulation controls, server management, and general UI controls
 */
export class Controls {
    private socketManager: SocketManager | null = null;
    private stateManager: StateManager;
    // Status checking is handled by ServerManager
    private currentServerStatus: ServerStatus = 'unknown';

    constructor(stateManager: StateManager) {
        this.stateManager = stateManager;
        // Don't initialize in constructor - wait for explicit init() call
        logger.debug('Controls', 'Instance created, waiting for init()');
    }

    /**
     * Initialize all control event handlers
     * Must be called after DOM is ready
     */
    public init(): void {
        logger.info('Controls', 'Initializing Controls...');
        
        try {
            this.bindSimulationControls();
            logger.debug('Controls', 'Simulation controls bound');
        } catch (error) {
            logger.error('Controls', '✗ Error binding simulation controls:', error);
        }
        
        try {
            this.bindServerControls();
            logger.debug('Controls', 'Server controls bound');
        } catch (error) {
            logger.error('Controls', '✗ Error binding server controls:', error);
        }
        
        try {
            this.bindUIControls();
            logger.debug('Controls', 'UI controls bound');
        } catch (error) {
            logger.error('Controls', '✗ Error binding UI controls:', error);
        }
        
        try {
            this.bindConfirmationHandlers();
            logger.debug('Controls', 'Confirmation handlers bound');
        } catch (error) {
            logger.error('Controls', '✗ Error binding confirmation handlers:', error);
        }

        // Status checking is now handled by ServerManager - no duplication
        logger.debug('Controls', 'Status checking handled by ServerManager');
    }

    /**
     * Set the socket manager for server communication
     */
    public setSocketManager(socketManager: SocketManager): void {
        this.socketManager = socketManager;
        this.bindSocketHandlers();
    }

    /**
     * Bind simulation control event handlers (play, pause, reset, speed)
     * NOTE: Header controls are now handled by Header.ts
     */
    private bindSimulationControls(): void {
        // Simulation controls moved to Header.ts to avoid duplicate event handlers
        logger.debug('Controls', 'Simulation controls are now handled by Header.ts');
    }

    /**
     * Bind server control event handlers
     */
    private bindServerControls(): void {
        // Server control buttons handled by ServerManager - no duplication
        logger.debug('Controls', 'Server control buttons handled by ServerManager');
    }

    /**
     * Bind general UI control event handlers
     * NOTE: Header UI controls are now handled by Header.ts
     */
    private bindUIControls(): void {
        logger.debug('Controls', 'Header UI controls are now handled by Header.ts');

        // Menu dropdown items are handled by Modals class - no duplication
        logger.debug('Controls', 'Menu dropdown items handled by Modals class');
    }

    /**
     * Bind confirmation modal handlers
     */
    private bindConfirmationHandlers(): void {
        // Server confirmation modals handled by ServerManager - no duplication
        logger.debug('Controls', 'Server confirmation modals handled by ServerManager');
    }

    /**
     * Bind socket event handlers for real-time updates
     */
    private bindSocketHandlers(): void {
        if (!this.socketManager) return;

        const socket = this.socketManager.getSocket();
        if (!socket) return;

        socket.on('server_status_update', (data: ServerResponse) => {
            this.handleStatusUpdate(data);
        });

        // Server logs and log streaming are handled by ServerManager
        logger.debug('Controls', 'Server log handlers managed by ServerManager');
    }

    // Simulation control commands (OP/HOLD/RESET/FF) are sent through the
    // console and header controls; Controls only tracks server status here.

    // Server Control Methods - Removed duplicate server control logic
    // Server management is now handled by ServerManager class
    // Status checking is also handled by ServerManager - no duplication

    /**
     * Update server status display
     */
    private updateStatus(message: string, status: ServerStatus): void {
        this.currentServerStatus = status;

        new StatusDisplayManager(
            document.getElementById('server-status-text-modal'),
            document.getElementById('server-status-indicator-modal')
        ).update(message, status);

        this.updateButtonStates(status);
        this.stateManager.updateServerStatus(status);
    }

    /**
     * Update button states based on server status
     */
    private updateButtonStates(_status: ServerStatus): void {
        // No server control buttons to update - status display only
    }

    /**
     * Handle server status updates from socket
     */
    private handleStatusUpdate(data: ServerResponse): void {
        if (data.status === 'success') {
            const status: ServerStatus = data.message.includes('running') ? 'running' : 
                         data.message.includes('Starting') || data.message.includes('Restarting') ? 'starting' :
                         data.message.includes('stopped') || data.message.includes('Stopped') ? 'stopped' : 'unknown';
            this.updateStatus(data.message, status);
        } else {
            this.updateStatus(data.message || 'Unknown error', 'unknown');
        }
    }

    // Server Log Methods - Removed duplicate log management logic
    // Log management is now handled by ServerManager class

    // Public API Methods

    /**
     * Get current server status
     */
    public getServerStatus(): ServerStatus {
        return this.currentServerStatus;
    }

    /**
     * Destroy the controls instance and clean up resources
     */
    public destroy(): void {
        // Status checking cleanup is handled by ServerManager
    }
}