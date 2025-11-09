import { ModalOptions, ModalState, ModalEventType, ModalEventHandler } from '../data/types';
import { logger } from '../utils/Logger';

/**
 * Centralized modal management system for the BlueSky Web UI
 * Handles modal lifecycle, events, and state management
 */
export class ModalManager {
    private modals: Map<string, ModalState> = new Map();
    private eventHandlers: Map<string, ModalEventHandler[]> = new Map();
    private initialized = false;
    private modalStack: string[] = []; // Track modal hierarchy for stacking

    constructor() {
        this.init();
    }

    private init(): void {
        if (this.initialized) return;
        
        // Initialize on DOM ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.initializeModals());
        } else {
            this.initializeModals();
        }
        
        this.initialized = true;
    }

    private initializeModals(): void {
        // Find all modal elements and register them
        const modalElements = document.querySelectorAll('[id$="-modal"]');
        modalElements.forEach((element) => {
            if (element instanceof HTMLElement && element.id) {
                this.registerModal(element.id);
            }
        });

        // Setup global event handlers for backdrop clicks
        this.setupGlobalEventHandlers();
    }

    private setupGlobalEventHandlers(): void {
        // Close modals when clicking on backdrop
        document.addEventListener('click', (event) => {
            const target = event.target as HTMLElement;
            if (target.classList.contains('modal') && target.id.endsWith('-modal')) {
                const modalId = target.id;
                if (this.isOpen(modalId)) {
                    this.close(modalId);
                }
            }
        });

        // Close modals with Escape key
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                const openModal = this.getOpenModal();
                if (openModal) {
                    this.close(openModal);
                }
            }
        });
    }

    /**
     * Register a modal for management
     */
    public registerModal(modalId: string, options?: Partial<ModalOptions>): void {
        const element = document.getElementById(modalId);
        if (!element) {
            logger.warn('ModalManager', `Modal element with id "${modalId}" not found`);
            return;
        }

        const modalState: ModalState = {
            isOpen: false,
            element
        };

        this.modals.set(modalId, modalState);

        // Setup close button if it exists
        const closeBtn = element.querySelector(`#${modalId}-close, .modal-close`);
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.close(modalId));
        }
    }

    /**
     * Open a modal by ID
     */
    public open(modalId: string): boolean {
        const modalState = this.modals.get(modalId);
        if (!modalState || !modalState.element) {
            logger.warn('ModalManager', `Modal "${modalId}" is not registered or element not found`);
            return false;
        }

        if (modalState.isOpen) {
            return true; // Already open
        }

        // Emit beforeOpen event
        this.emitEvent('beforeOpen', modalId);

        // Check if this is a confirmation modal that should stack on top
        const isConfirmationModal = modalId.includes('server-stop-modal') || modalId.includes('server-restart-modal');
        
        if (!isConfirmationModal) {
            // For non-confirmation modals, close all other modals
            this.closeAll();
        }

        // Show the modal
        modalState.element.style.display = 'flex';
        modalState.isOpen = true;
        
        // Add to modal stack
        this.modalStack.push(modalId);
        
        // Add body class to prevent scrolling
        document.body.classList.add('modal-open');

        // Emit open event
        this.emitEvent('open', modalId);

        return true;
    }

    /**
     * Close a modal by ID
     */
    public close(modalId: string): boolean {
        const modalState = this.modals.get(modalId);
        if (!modalState || !modalState.element) {
            logger.warn('ModalManager', `Modal "${modalId}" is not registered or element not found`);
            return false;
        }

        if (!modalState.isOpen) {
            return true; // Already closed
        }

        // Emit beforeClose event
        this.emitEvent('beforeClose', modalId);

        // Hide the modal
        modalState.element.style.display = 'none';
        modalState.isOpen = false;

        // Remove from modal stack
        const stackIndex = this.modalStack.indexOf(modalId);
        if (stackIndex > -1) {
            this.modalStack.splice(stackIndex, 1);
        }

        // Only remove body class if no modals are open
        if (this.modalStack.length === 0) {
            document.body.classList.remove('modal-open');
        }

        // Emit close event
        this.emitEvent('close', modalId);

        return true;
    }

    /**
     * Close all open modals
     */
    public closeAll(): void {
        this.modals.forEach((state, modalId) => {
            if (state.isOpen) {
                this.close(modalId);
            }
        });
        // Clear the modal stack
        this.modalStack = [];
    }

    /**
     * Check if a modal is open
     */
    public isOpen(modalId: string): boolean {
        const modalState = this.modals.get(modalId);
        return modalState ? modalState.isOpen : false;
    }

    /**
     * Get the currently open modal ID, if any
     */
    public getOpenModal(): string | null {
        // Return the top modal from the stack (most recently opened)
        return this.modalStack.length > 0 ? this.modalStack[this.modalStack.length - 1] : null;
    }

    /**
     * Add event handler for modal events
     */
    public on(modalId: string, handler: ModalEventHandler): void {
        if (!this.eventHandlers.has(modalId)) {
            this.eventHandlers.set(modalId, []);
        }
        this.eventHandlers.get(modalId)!.push(handler);
    }

    /**
     * Remove event handler
     */
    public off(modalId: string, handler: ModalEventHandler): void {
        const handlers = this.eventHandlers.get(modalId);
        if (handlers) {
            const index = handlers.indexOf(handler);
            if (index > -1) {
                handlers.splice(index, 1);
            }
        }
    }

    /**
     * Emit modal event
     */
    private emitEvent(eventType: ModalEventType, modalId: string): void {
        const handlers = this.eventHandlers.get(modalId);
        if (handlers) {
            handlers.forEach(handler => {
                try {
                    handler(eventType, modalId);
                } catch (error) {
                    logger.error('ModalManager', `Error in modal event handler for ${modalId}:`, error);
                }
            });
        }
    }

    /**
     * Get modal element by ID
     */
    public getModal(modalId: string): HTMLElement | null {
        const modalState = this.modals.get(modalId);
        return modalState ? modalState.element : null;
    }

    /**
     * Check if modal manager is initialized
     */
    public isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * Get list of registered modal IDs
     */
    public getRegisteredModals(): string[] {
        return Array.from(this.modals.keys());
    }
}

// Create and export singleton instance
export const modalManager = new ModalManager();