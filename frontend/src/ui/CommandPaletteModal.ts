/**
 * CommandPaletteModal — Ctrl+K / Ctrl+Shift+P overlay (also opened via
 * the "Commands" button in the console header) that lets the user
 * fuzzy-search every BlueSky command. Selecting a row inserts the command
 * name into the console input and closes the modal.
 */

import { CommandListView } from './CommandListView';
import { modalManager } from './ModalManager';
import type { StateManager } from '../core/StateManager';
import type { Console } from './Console';
import { logger } from '../utils/Logger';

export const COMMAND_PALETTE_MODAL_ID = 'command-palette-modal';

export class CommandPaletteModal {
    private listView: CommandListView | null = null;
    private stateManager: StateManager | null = null;
    private consoleRef: Console | null = null;
    private registered = false;

    public setStateManager(stateManager: StateManager): void {
        this.stateManager = stateManager;
        this.tryRegister();
    }

    public setConsole(consoleRef: Console): void {
        this.consoleRef = consoleRef;
        this.tryRegister();
    }

    private tryRegister(): void {
        if (this.registered) return;
        if (!this.stateManager || !this.consoleRef) return;

        const container = document.getElementById('command-palette-list-container');
        if (!container) {
            logger.warn(
                'CommandPaletteModal',
                'command-palette-list-container not found'
            );
            return;
        }

        this.listView = new CommandListView({
            container,
            stateManager: this.stateManager,
            console: this.consoleRef,
            placeholder: 'Type to search commands…',
            onSelect: () => this.close(),
        });

        // ModalManager auto-registers any element matching `[id$="-modal"]`
        // during its DOMContentLoaded pass, but if the element is absent at
        // that moment we re-register here to be safe.
        if (!modalManager.getModal(COMMAND_PALETTE_MODAL_ID)) {
            modalManager.registerModal(COMMAND_PALETTE_MODAL_ID);
        }

        modalManager.on(COMMAND_PALETTE_MODAL_ID, (event) => {
            if (event === 'open') {
                // Re-read recents from storage so the modal reflects the
                // commands the user has issued since last open.
                this.listView?.refreshRecents();
                // Defer focus until the modal is actually visible.
                setTimeout(() => this.listView?.focusSearch(), 0);
            }
        });

        this.registered = true;
    }

    public open(): void {
        if (!this.registered) {
            logger.warn(
                'CommandPaletteModal',
                'open() called before registration — dependencies not set yet'
            );
            return;
        }
        modalManager.open(COMMAND_PALETTE_MODAL_ID);
    }

    public close(): void {
        modalManager.close(COMMAND_PALETTE_MODAL_ID);
    }

    public isOpen(): boolean {
        return modalManager.isOpen(COMMAND_PALETTE_MODAL_ID);
    }

    public destroy(): void {
        if (this.listView) {
            this.listView.destroy();
            this.listView = null;
        }
    }
}
