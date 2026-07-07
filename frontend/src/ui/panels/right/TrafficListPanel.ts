/**
 * TrafficListPanel - Manages the Traffic List panel
 *
 * Displays all aircraft in the simulation as a clickable list and keeps
 * the highlighted entry in sync with the shared aircraft selection.
 */

import { BasePanel } from '../BasePanel';
import { AircraftClickSelector } from '../AircraftClickSelector';
import { AircraftData } from '../../../data/types';
import { StateManager } from '../../../core/StateManager';
import { logger } from '../../../utils/Logger';

export class TrafficListPanel extends BasePanel {
    private trafficListElement: HTMLElement | null = null;
    private stateManager: StateManager | null = null;
    private currentAircraftData: AircraftData | null = null;
    private selectedAircraft: string | null = null;
    private clickSelector = new AircraftClickSelector('TrafficListPanel', () => this.stateManager);

    constructor() {
        super('.traffic-panel', 'traffic-content');
    }

    protected onInit(): void {
        this.trafficListElement = document.getElementById('traffic-list');

        if (!this.trafficListElement) {
            logger.warn('TrafficListPanel', 'Traffic list element not found');
            return;
        }

        logger.debug('TrafficListPanel', 'TrafficListPanel initialized');
    }

    /**
     * Set the state manager to enable aircraft selection coordination
     */
    public setStateManager(stateManager: StateManager): void {
        this.stateManager = stateManager;

        this.stateManager.subscribe('selectedAircraft', (newAircraft) => {
            this.selectedAircraft = newAircraft;
            this.updateSelectionVisuals();
        });

        this.stateManager.subscribe('aircraftData', (newData) => {
            this.currentAircraftData = newData;
            this.updateTrafficList();
        });
    }

    /**
     * Update the traffic list with current aircraft data
     */
    public update(data?: AircraftData): void {
        if (data) {
            this.currentAircraftData = data;
        }
        this.updateTrafficList();
    }

    /**
     * Reconcile the list against the current aircraft data: existing items
     * are kept (preserving their click listeners), removed aircraft are
     * dropped, and new aircraft are appended.
     */
    private updateTrafficList(): void {
        if (!this.trafficListElement) return;

        const ids = (this.currentAircraftData?.id ?? []).filter(id => id && id.trim() !== '');
        const wanted = new Set(ids);

        const existing = new Map<string, HTMLElement>();
        for (const child of Array.from(this.trafficListElement.children) as HTMLElement[]) {
            const id = child.textContent ?? '';
            if (wanted.has(id)) {
                existing.set(id, child);
            } else {
                child.remove();
            }
        }

        for (const aircraftId of ids) {
            let item = existing.get(aircraftId);
            if (!item) {
                item = document.createElement('div');
                item.className = 'traffic-item';
                item.textContent = aircraftId;
                this.clickSelector.attach(item, aircraftId);
                this.trafficListElement.appendChild(item);
                existing.set(aircraftId, item);
            }
            item.classList.toggle('selected', this.selectedAircraft === aircraftId);
        }
    }

    /**
     * Update visual selection state for all traffic items
     */
    private updateSelectionVisuals(): void {
        if (!this.trafficListElement) return;

        this.trafficListElement.querySelectorAll('.traffic-item').forEach(item => {
            item.classList.toggle('selected', this.selectedAircraft === item.textContent);
        });
    }

    /**
     * Get selected aircraft ID
     */
    public getSelectedAircraft(): string | null {
        return this.selectedAircraft;
    }

    /**
     * Programmatically select an aircraft
     */
    public selectAircraft(aircraftId: string | null): void {
        if (this.stateManager) {
            this.stateManager.setSelectedAircraft(aircraftId);
        }
    }

    /**
     * Clear selection
     */
    public clearSelection(): void {
        this.selectAircraft(null);
    }

    protected override onDestroy(): void {
        this.clickSelector.dispose();
    }
}
