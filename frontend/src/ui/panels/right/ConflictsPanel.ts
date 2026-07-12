/**
 * ConflictsPanel - Manages the Conflicts panel
 *
 * Displays aircraft currently in conflict (inconf === true) with their
 * TCPA (Time to Closest Point of Approach). The list DOM is only rebuilt
 * when the set of conflicting aircraft changes; the TCPA values are
 * refreshed in place on every data update so they keep counting down.
 */

import { BasePanel } from '../BasePanel';
import { AircraftClickSelector } from '../AircraftClickSelector';
import { AircraftData } from '../../../data/types';
import { StateManager } from '../../../core/StateManager';
import { logger } from '../../../utils/Logger';
import { escapeHtml } from '../../../utils/dom';

interface ConflictEntry {
    id: string;
    tcpa: number | null;
}

export class ConflictsPanel extends BasePanel {
    private conflictsInfoElement: HTMLElement | null = null;
    private stateManager: StateManager | null = null;
    private currentAircraftData: AircraftData | null = null;
    private selectedAircraft: string | null = null;
    private lastConflictIds: string[] = [];
    private clickSelector = new AircraftClickSelector('ConflictsPanel', () => this.stateManager);

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

        this.trackSubscription(this.stateManager.subscribe('selectedAircraft', (newAircraft) => {
            this.selectedAircraft = newAircraft;
            this.updateSelectionVisuals();
        }));

        this.trackSubscription(this.stateManager.subscribe('aircraftData', (newData) => {
            this.currentAircraftData = newData;
            this.updateConflictsDisplay();
        }));
    }

    /**
     * Update panel with new data
     */
    public update(data?: AircraftData): void {
        if (data) {
            this.currentAircraftData = data;
        }
        this.updateConflictsDisplay();
    }

    /**
     * Collect the aircraft currently in conflict from the latest data.
     */
    private getConflictAircraft(): ConflictEntry[] {
        const data = this.currentAircraftData;
        if (!data?.id || !data?.inconf) return [];

        const conflicts: ConflictEntry[] = [];
        for (let i = 0; i < data.id.length; i++) {
            const aircraftId = data.id[i];
            if (aircraftId && aircraftId.trim() !== '' && data.inconf[i]) {
                const tcpa = data.tcpamax?.[i];
                conflicts.push({
                    id: aircraftId,
                    tcpa: typeof tcpa === 'number' && Number.isFinite(tcpa) ? tcpa : null,
                });
            }
        }
        return conflicts;
    }

    /**
     * Rebuild the list only when the conflicting aircraft changed;
     * otherwise just refresh the TCPA values in place.
     */
    private updateConflictsDisplay(): void {
        const conflicts = this.getConflictAircraft();
        const currentIds = conflicts.map(c => c.id);

        const changed =
            currentIds.length !== this.lastConflictIds.length ||
            currentIds.some((id, i) => id !== this.lastConflictIds[i]);

        if (changed) {
            this.renderConflictsList(conflicts);
            this.lastConflictIds = currentIds;
        } else if (conflicts.length > 0) {
            this.updateTcpaValues(conflicts);
        }
    }

    private formatTcpa(tcpa: number | null): string {
        return tcpa !== null ? `TCPA: ${tcpa.toFixed(1)}s` : '';
    }

    /**
     * Rebuild the conflicts list DOM and reattach click handlers.
     */
    private renderConflictsList(conflicts: ConflictEntry[]): void {
        if (!this.conflictsInfoElement) return;

        if (conflicts.length === 0) {
            this.conflictsInfoElement.innerHTML = '<div class="no-conflicts">No conflicts detected</div>';
            return;
        }

        let html = '<div class="conflicts-list">';
        conflicts.forEach(conflict => {
            const safeId = escapeHtml(conflict.id);
            html += `
                <div class="conflict-item" data-aircraft-id="${safeId}">
                    <div class="conflict-pair"><strong>${safeId}</strong></div>
                    <div class="conflict-tcpa">${this.formatTcpa(conflict.tcpa)}</div>
                </div>
            `;
        });
        html += '</div>';

        this.conflictsInfoElement.innerHTML = html;

        this.conflictsInfoElement.querySelectorAll('.conflict-item').forEach(item => {
            const htmlItem = item as HTMLElement;
            const aircraftId = htmlItem.dataset.aircraftId;
            if (aircraftId) {
                this.clickSelector.attach(htmlItem, aircraftId);
            }
        });

        this.updateSelectionVisuals();
    }

    /**
     * Refresh the TCPA text of the existing items without rebuilding them.
     */
    private updateTcpaValues(conflicts: ConflictEntry[]): void {
        if (!this.conflictsInfoElement) return;

        const tcpaById = new Map(conflicts.map(c => [c.id, c.tcpa]));
        this.conflictsInfoElement.querySelectorAll('.conflict-item').forEach(item => {
            const aircraftId = (item as HTMLElement).dataset.aircraftId;
            const tcpaElement = item.querySelector('.conflict-tcpa');
            if (aircraftId && tcpaElement) {
                tcpaElement.textContent = this.formatTcpa(tcpaById.get(aircraftId) ?? null);
            }
        });
    }

    /**
     * Update visual selection state for all conflict items
     */
    private updateSelectionVisuals(): void {
        if (!this.conflictsInfoElement) return;

        this.conflictsInfoElement.querySelectorAll('.conflict-item').forEach(item => {
            const htmlItem = item as HTMLElement;
            htmlItem.classList.toggle('selected', this.selectedAircraft === htmlItem.dataset.aircraftId);
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

    protected override onDestroy(): void {
        this.clickSelector.dispose();
        this.lastConflictIds = [];
    }
}
