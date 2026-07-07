import { modalManager } from './ModalManager';
import { blueSkyFileManager } from './BlueSkyFileManager';
import { logger } from '../utils/Logger';
import { onDOMReady } from '../utils/dom';

/**
 * Wires the header/footer buttons of the standard modals to the modal manager.
 *
 * Modal registration and close ("X") buttons are handled by ModalManager
 * itself (it auto-registers every `[id$="-modal"]` element on DOM ready and
 * wires their `.modal-close` buttons); this class only adds the wiring that
 * is specific to individual modals.
 */
export class Modals {
    private initialized = false;

    constructor() {
        onDOMReady(() => this.initializeModals());
    }

    private initializeModals(): void {
        if (this.initialized) return;
        this.setupModalButtons();
        this.initialized = true;
    }

    private setupModalButtons(): void {
        // Open button: routed through the file manager so it can reset its
        // browse state before the modal opens.
        const uploadBtn = document.getElementById('upload-files-btn');
        if (uploadBtn) {
            uploadBtn.addEventListener('click', (e) => {
                e.preventDefault();
                blueSkyFileManager.openModal();
            });
        } else {
            logger.warn('Modals', 'Button not found: upload-files-btn');
        }

        // Cancel buttons just close; their owning managers clear the form
        // fields on the next open.
        const cancelButtons = [
            { buttonId: 'cancel-aircraft-btn', modalId: 'create-aircraft-modal' },
            { buttonId: 'cancel-polygon-btn', modalId: 'polygon-name-modal' }
        ];

        cancelButtons.forEach(({ buttonId, modalId }) => {
            const button = document.getElementById(buttonId);
            button?.addEventListener('click', () => modalManager.close(modalId));
        });
    }

    /**
     * Idempotent manual initialization, called from App in case the DOM-ready
     * callback has not fired yet.
     */
    public forceInitialize(): void {
        this.initializeModals();
    }
}

// Export singleton instance
export const modals = new Modals();
