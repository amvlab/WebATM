import { modalManager } from './ModalManager';
import { settingsModal } from './SettingsModal';
import { serverManager } from './ServerManager';
import { logger } from '../utils/Logger';

/**
 * Central Modals System
 * Coordinates all modal components and provides a unified interface
 * This replaces the generic modal methods from app.js
 */
export class Modals {
    private initialized = false;

    constructor() {
        this.init();
    }

    private init(): void {
        if (this.initialized) return;

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.initializeModals());
        } else {
            this.initializeModals();
        }
    }

    private initializeModals(): void {
        // Register all standard modals with the modal manager
        const standardModals = [
            'upload-scenario-modal',
            'modify-settings-modal',
            'download-logs-modal',
            'upload-plugin-modal',
            'create-aircraft-modal',
            'polygon-name-modal'
        ];

        standardModals.forEach(modalId => {
            modalManager.registerModal(modalId);
        });

        // Setup event handlers for standard modals
        this.setupStandardModalHandlers();

        this.initialized = true;
    }

    private setupStandardModalHandlers(): void {
        logger.debug('Modals', 'Setting up standard modal handlers...');

        // Button handlers to open modals
        const modalButtons = [
            { buttonId: 'upload-scenario-btn', modalId: 'upload-scenario-modal' },
            { buttonId: 'modify-settings-btn', modalId: 'modify-settings-modal' },
            { buttonId: 'download-logs-btn', modalId: 'download-logs-modal' },
            { buttonId: 'upload-plugin-btn', modalId: 'upload-plugin-modal' }
        ];

        modalButtons.forEach(({ buttonId, modalId }) => {
            const button = document.getElementById(buttonId);
            if (button) {
                logger.debug('Modals', `Modal handler attached: ${buttonId} -> ${modalId}`);
                button.addEventListener('click', (e) => {
                    e.preventDefault();
                    logger.debug('Modals', `Opening modal: ${modalId}`);
                    this.openModal(modalId);
                    this.closeMenuDropdown();
                });
            } else {
                logger.warn('Modals', `✗ Button not found: ${buttonId}`);
            }
        });

        // Close button handlers
        const closeButtons = [
            { buttonId: 'upload-scenario-close', modalId: 'upload-scenario-modal' },
            { buttonId: 'modify-settings-close', modalId: 'modify-settings-modal' },
            { buttonId: 'download-logs-close', modalId: 'download-logs-modal' },
            { buttonId: 'upload-plugin-close', modalId: 'upload-plugin-modal' },
            { buttonId: 'create-aircraft-modal-close', modalId: 'create-aircraft-modal' },
            { buttonId: 'polygon-name-modal-close', modalId: 'polygon-name-modal' }
        ];

        closeButtons.forEach(({ buttonId, modalId }) => {
            const button = document.getElementById(buttonId);
            if (button) {
                button.addEventListener('click', () => this.closeModal(modalId));
            }
        });

        // OK button handlers (typically just close the modal)
        const okButtons = [
            { buttonId: 'upload-scenario-ok', modalId: 'upload-scenario-modal' },
            { buttonId: 'modify-settings-ok', modalId: 'modify-settings-modal' },
            { buttonId: 'download-logs-ok', modalId: 'download-logs-modal' },
            { buttonId: 'upload-plugin-ok', modalId: 'upload-plugin-modal' }
        ];

        okButtons.forEach(({ buttonId, modalId }) => {
            const button = document.getElementById(buttonId);
            if (button) {
                button.addEventListener('click', () => this.closeModal(modalId));
            }
        });

        // Cancel button handlers for aircraft and polygon modals
        // Note: These modals have special functionality managed by their respective managers
        // but we still register basic close handlers here
        const cancelButtons = [
            { buttonId: 'cancel-aircraft-btn', modalId: 'create-aircraft-modal' },
            { buttonId: 'cancel-polygon-btn', modalId: 'polygon-name-modal' }
        ];

        cancelButtons.forEach(({ buttonId, modalId }) => {
            const button = document.getElementById(buttonId);
            if (button) {
                button.addEventListener('click', () => this.closeModal(modalId));
            }
        });
    }

    /**
     * Generic modal methods (replacing the ones from app.js)
     */
    public openModal(modalId: string): boolean {
        return modalManager.open(modalId);
    }

    public closeModal(modalId: string): boolean {
        return modalManager.close(modalId);
    }

    /**
     * Close all modals
     */
    public closeAllModals(): void {
        modalManager.closeAll();
    }

    /**
     * Check if a modal is open
     */
    public isModalOpen(modalId: string): boolean {
        return modalManager.isOpen(modalId);
    }

    /**
     * Get the currently open modal, if any
     */
    public getOpenModal(): string | null {
        return modalManager.getOpenModal();
    }

    /**
     * Specific modal access methods
     */
    public getSettingsModal() {
        return settingsModal;
    }

    public getServerManager() {
        return serverManager;
    }

    public getModalManager() {
        return modalManager;
    }

    /**
     * Helper method to close menu dropdown
     */
    private closeMenuDropdown(): void {
        const dropdown = document.getElementById('menu-dropdown');
        if (dropdown) {
            dropdown.style.display = 'none';
        }

        // Emit event for menu dropdown close
        const event = new CustomEvent('menuDropdownClosed');
        document.dispatchEvent(event);
    }

    /**
     * Integration methods for main application
     */

    /**
     * Set socket for server manager integration
     */
    public setSocket(socket: any): void {
        serverManager.setSocket(socket);
    }

    /**
     * Update server status across all components
     */
    public updateServerStatus(_status: string): void {
        // This can be called by the main app to update server status
        // The server manager will handle the actual status updates
    }

    /**
     * Set BlueSky connection status for settings modal
     */
    public setBlueSkyConnected(connected: boolean): void {
        settingsModal.setBlueSkyConnected(connected);
    }

    /**
     * Check if the modal system is initialized
     */
    public isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * Manual initialization (if needed)
     */
    public forceInitialize(): void {
        if (!this.initialized) {
            this.initializeModals();
        }
    }
}

// Export singleton instance
export const modals = new Modals();

// Also export individual components for direct access
export { modalManager, settingsModal, serverManager };