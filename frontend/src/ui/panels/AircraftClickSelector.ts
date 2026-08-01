import type { StateManager } from '../../core/StateManager';
import { logger } from '../../utils/Logger';

/**
 * AircraftClickSelector - shared single/double-click selection behavior
 * for list items that represent an aircraft (traffic list, conflicts
 * list).
 *
 * Single click toggles selection through the StateManager and dispatches
 * 'aircraft-single-click' (pan) when selecting or 'aircraft-unselect'
 * when unselecting. A second click within 300ms cancels the pending
 * single click and dispatches 'aircraft-double-click' (zoom/follow).
 */
export class AircraftClickSelector {
    private clickTimeouts: Map<string, number> = new Map();

    constructor(
        private component: string,
        private getStateManager: () => StateManager | null
    ) {}

    /**
     * Attach the click behavior to a list item element.
     */
    public attach(element: HTMLElement, aircraftId: string): void {
        element.addEventListener('click', () => {
            const pending = this.clickTimeouts.get(aircraftId);
            if (pending !== undefined) {
                // Second click within the window: cancel the pending single click
                clearTimeout(pending);
                this.clickTimeouts.delete(aircraftId);
                this.handleDoubleClick(aircraftId);
                return;
            }

            const timeout = window.setTimeout(() => {
                this.clickTimeouts.delete(aircraftId);
                this.handleSingleClick(aircraftId);
            }, 300);
            this.clickTimeouts.set(aircraftId, timeout);
        });
    }

    /**
     * Single click: toggle selection; pan to the aircraft when selecting.
     */
    private handleSingleClick(aircraftId: string): void {
        const stateManager = this.getStateManager();
        if (!stateManager) return;

        if (stateManager.getState().selectedAircraft === aircraftId) {
            stateManager.setSelectedAircraft(null);
            logger.debug(this.component, `Unselected aircraft: ${aircraftId}`);

            // Let the map mirror its own unselect path (stop following,
            // toggle the server-side route broadcast off).
            document.dispatchEvent(new CustomEvent('aircraft-unselect', {
                detail: { aircraftId }
            }));
        } else {
            stateManager.setSelectedAircraft(aircraftId);
            logger.debug(this.component, `Selected aircraft: ${aircraftId}`);

            document.dispatchEvent(new CustomEvent('aircraft-single-click', {
                detail: { aircraftId }
            }));
        }
    }

    /**
     * Double click: select and zoom/follow.
     */
    private handleDoubleClick(aircraftId: string): void {
        const stateManager = this.getStateManager();
        if (!stateManager) return;

        stateManager.setSelectedAircraft(aircraftId);

        document.dispatchEvent(new CustomEvent('aircraft-double-click', {
            detail: { aircraftId }
        }));

        logger.debug(this.component, `Double-clicked aircraft: ${aircraftId} - zooming/following`);
    }

    /**
     * Cancel pending single-click timers (call from the panel's destroy).
     */
    public dispose(): void {
        this.clickTimeouts.forEach(timeout => clearTimeout(timeout));
        this.clickTimeouts.clear();
    }
}
