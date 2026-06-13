import type { StateManager } from '../../core/StateManager';
import { logger } from '../../utils/Logger';

/**
 * AircraftClickSelector - shared single/double-click selection behavior
 * for list items that represent an aircraft (traffic list, conflicts
 * list).
 *
 * Single click toggles selection through the StateManager and, when
 * selecting, dispatches 'aircraft-single-click' so the map can pan.
 * Double click (within 300ms) selects and dispatches
 * 'aircraft-double-click' for zoom/follow. The delay timer per aircraft
 * is tracked so a pending single-click is cancelled by the second click.
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
    public attach(element: HTMLElement, aircraftId: string, index: number): void {
        let clickCount = 0;

        element.addEventListener('click', () => {
            clickCount++;

            // Clear any existing timeout for this aircraft
            const existingTimeout = this.clickTimeouts.get(aircraftId);
            if (existingTimeout) {
                clearTimeout(existingTimeout);
                this.clickTimeouts.delete(aircraftId);
            }

            if (clickCount === 2) {
                // Double click detected - select and zoom/follow aircraft
                clickCount = 0;
                this.handleDoubleClick(aircraftId, index);
            } else {
                // Single click - wait to see if there's a second click
                const timeout = window.setTimeout(() => {
                    clickCount = 0;
                    this.clickTimeouts.delete(aircraftId);
                    this.handleSingleClick(aircraftId, index);
                }, 300); // 300ms delay to detect double-click

                this.clickTimeouts.set(aircraftId, timeout);
            }
        });
    }

    /**
     * Single click: toggle selection; pan to the aircraft when selecting.
     */
    private handleSingleClick(aircraftId: string, index: number): void {
        const stateManager = this.getStateManager();
        if (!stateManager) return;

        if (stateManager.getState().selectedAircraft === aircraftId) {
            stateManager.setSelectedAircraft(null);
            logger.debug(this.component, `Unselected aircraft: ${aircraftId}`);
        } else {
            stateManager.setSelectedAircraft(aircraftId);
            logger.debug(this.component, `Selected aircraft: ${aircraftId}`);

            document.dispatchEvent(new CustomEvent('aircraft-single-click', {
                detail: { aircraftId, index }
            }));
        }
    }

    /**
     * Double click: select and zoom/follow.
     */
    private handleDoubleClick(aircraftId: string, index: number): void {
        const stateManager = this.getStateManager();
        if (!stateManager) return;

        stateManager.setSelectedAircraft(aircraftId);

        document.dispatchEvent(new CustomEvent('aircraft-double-click', {
            detail: { aircraftId, index }
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
