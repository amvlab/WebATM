/**
 * ConflictsPanel - Manages the Conflicts panel
 *
 * This panel handles:
 * - Displaying aircraft currently in conflict (inconf === true)
 * - TCPA (Time to Closest Point of Approach) display
 * - Aircraft selection with single/double click support
 * - Scrollable conflict list
 * - Real-time updates with change detection optimization
 */

import { BasePanel } from '../BasePanel';
import { AircraftData } from '../../../data/types';
import { StateManager } from '../../../core/StateManager';
import { logger } from '../../../utils/Logger';

export class ConflictsPanel extends BasePanel {
    private conflictsInfoElement: HTMLElement | null = null;
    private stateManager: StateManager | null = null;
    private currentAircraftData: AircraftData | null = null;
    private selectedAircraft: string | null = null;
    private lastConflictIds: string[] = [];
    private clickTimeouts: Map<string, number> = new Map();

    constructor() {
        super('.conflicts-panel', 'conflicts-content');
    }

    protected onInit(): void {
        this.conflictsInfoElement = document.getElementById('conflicts-info');

        if (!this.conflictsInfoElement) {
            logger.warn('ConflictsPanel', 'Conflicts info element not found');
            return;
        }

        logger.debug('ConflictsPanel', 'ConflictsPanel initialized');
    }

    /**
     * Set the state manager to enable aircraft selection coordination
     */
    public setStateManager(stateManager: StateManager): void {
        this.stateManager = stateManager;

        // Subscribe to selected aircraft changes
        this.stateManager.subscribe('selectedAircraft', (newAircraft) => {
            this.selectedAircraft = newAircraft;
            this.updateSelectionVisuals();
        });

        // Subscribe to aircraft data updates
        this.stateManager.subscribe('aircraftData', (newData) => {
            this.currentAircraftData = newData;
            this.updateConflictsListIfChanged();
        });
    }

    /**
     * Update panel with new data
     */
    public update(data?: AircraftData): void {
        if (data) {
            this.currentAircraftData = data;
        }
        this.updateConflictsListIfChanged();
    }

    /**
     * Only update conflicts list if conflicts actually changed (optimization)
     */
    private updateConflictsListIfChanged(): void {
        if (!this.currentAircraftData?.id || !this.currentAircraftData?.inconf) {
            if (this.lastConflictIds.length > 0) {
                // Had conflicts before, now have none - update
                this.updateConflictsList();
                this.lastConflictIds = [];
            }
            return;
        }

        // Find current aircraft in conflict
        const currentConflictIds: string[] = [];
        for (let i = 0; i < this.currentAircraftData.id.length; i++) {
            if (this.currentAircraftData.id[i] &&
                this.currentAircraftData.id[i].trim() !== '' &&
                this.currentAircraftData.inconf[i]) {
                currentConflictIds.push(this.currentAircraftData.id[i]);
            }
        }

        // Check if conflicts changed
        const conflictsChanged =
            this.lastConflictIds.length !== currentConflictIds.length ||
            !this.lastConflictIds.every(id => currentConflictIds.includes(id)) ||
            !currentConflictIds.every(id => this.lastConflictIds.includes(id));

        if (conflictsChanged) {
            this.updateConflictsList();
            this.lastConflictIds = currentConflictIds;
        }
    }

    /**
     * Update conflicts list display
     */
    private updateConflictsList(): void {
        if (!this.conflictsInfoElement) return;

        if (!this.currentAircraftData?.id || !this.currentAircraftData?.inconf) {
            this.conflictsInfoElement.innerHTML = '<div class="no-conflicts">No conflicts detected</div>';
            return;
        }

        // Find all aircraft in conflict
        const conflictAircraft: Array<{ id: string; index: number; tcpa: number | null }> = [];

        for (let i = 0; i < this.currentAircraftData.id.length; i++) {
            const aircraftId = this.currentAircraftData.id[i];
            if (aircraftId && aircraftId.trim() !== '' && this.currentAircraftData.inconf[i]) {
                const tcpa = this.currentAircraftData.tcpamax && this.currentAircraftData.tcpamax[i]
                    ? this.currentAircraftData.tcpamax[i]
                    : null;

                conflictAircraft.push({
                    id: aircraftId,
                    index: i,
                    tcpa: tcpa
                });
            }
        }

        if (conflictAircraft.length === 0) {
            this.conflictsInfoElement.innerHTML = '<div class="no-conflicts">No conflicts detected</div>';
            return;
        }

        // Build conflicts list HTML
        let html = '<div class="conflicts-list">';
        conflictAircraft.forEach(conflict => {
            const tcpaStr = conflict.tcpa !== null ? `TCPA: ${conflict.tcpa.toFixed(1)}s` : '';

            html += `
                <div class="conflict-item" data-aircraft-id="${conflict.id}" data-index="${conflict.index}">
                    <div class="conflict-pair"><strong>${conflict.id}</strong></div>
                    <div class="conflict-tcpa">${tcpaStr}</div>
                </div>
            `;
        });
        html += '</div>';

        this.conflictsInfoElement.innerHTML = html;

        // Add click handlers to conflict items
        const conflictItems = this.conflictsInfoElement.querySelectorAll('.conflict-item');
        conflictItems.forEach(item => {
            const htmlItem = item as HTMLElement;
            const aircraftId = htmlItem.getAttribute('data-aircraft-id');
            const indexAttr = htmlItem.getAttribute('data-index');

            if (aircraftId && indexAttr) {
                const index = parseInt(indexAttr);
                this.addConflictClickHandlers(htmlItem, aircraftId, index);
            }
        });

        // Update selection state after rebuilding
        this.updateSelectionVisuals();
    }

    /**
     * Add click handlers for conflict items (single and double click)
     */
    private addConflictClickHandlers(element: HTMLElement, aircraftId: string, index: number): void {
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
                this.handleConflictDoubleClick(aircraftId, index);
            } else {
                // Single click - wait to see if there's a second click
                const timeout = window.setTimeout(() => {
                    clickCount = 0;
                    this.clickTimeouts.delete(aircraftId);
                    this.handleConflictSingleClick(aircraftId, index);
                }, 300); // 300ms delay to detect double-click

                this.clickTimeouts.set(aircraftId, timeout);
            }
        });
    }

    /**
     * Handle single click on conflict item
     */
    private handleConflictSingleClick(aircraftId: string, index: number): void {
        if (!this.stateManager) return;

        // Check if clicking the same aircraft that's already selected
        const isSameAircraft = this.selectedAircraft === aircraftId;

        if (isSameAircraft) {
            // Unselect aircraft
            this.stateManager.setSelectedAircraft(null);
            logger.debug('ConflictsPanel', `Unselected aircraft from conflicts: ${aircraftId}`);
        } else {
            // Select new aircraft
            this.stateManager.setSelectedAircraft(aircraftId);
            logger.debug('ConflictsPanel', `Selected aircraft from conflicts: ${aircraftId}`);

            // Emit custom event for map to handle zoom/pan
            const event = new CustomEvent('aircraft-single-click', {
                detail: { aircraftId, index }
            });
            document.dispatchEvent(event);
        }
    }

    /**
     * Handle double click on conflict item (zoom/follow behavior)
     */
    private handleConflictDoubleClick(aircraftId: string, index: number): void {
        if (!this.stateManager) return;

        // Select aircraft
        this.stateManager.setSelectedAircraft(aircraftId);

        // Emit custom event for map to handle zoom/follow
        const event = new CustomEvent('aircraft-double-click', {
            detail: { aircraftId, index }
        });
        document.dispatchEvent(event);

        logger.debug('ConflictsPanel', `Double-clicked conflict aircraft: ${aircraftId} - zooming/following`);
    }

    /**
     * Update visual selection state for all conflict items
     */
    private updateSelectionVisuals(): void {
        if (!this.conflictsInfoElement) return;

        const conflictItems = this.conflictsInfoElement.querySelectorAll('.conflict-item');
        conflictItems.forEach(item => {
            const htmlItem = item as HTMLElement;
            const aircraftId = htmlItem.getAttribute('data-aircraft-id');

            if (this.selectedAircraft === aircraftId) {
                htmlItem.classList.add('selected');
            } else {
                htmlItem.classList.remove('selected');
            }
        });
    }

    /**
     * Clear the conflicts display
     */
    public clearConflicts(): void {
        if (this.conflictsInfoElement) {
            this.conflictsInfoElement.innerHTML = '<div class="no-conflicts">No conflicts detected</div>';
            this.lastConflictIds = [];
        }
    }

    protected onDestroy(): void {
        // Clear all click timeouts
        this.clickTimeouts.forEach(timeout => clearTimeout(timeout));
        this.clickTimeouts.clear();
        this.lastConflictIds = [];
    }
}
