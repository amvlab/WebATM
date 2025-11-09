/**
 * TrafficListPanel - Manages the Traffic List panel
 *
 * This panel handles:
 * - Displaying list of all aircraft in simulation
 * - Aircraft selection with single/double click support
 * - Aircraft filtering/search
 * - Traffic count display
 * - Syncing selection with map and other components
 */

import { BasePanel } from '../BasePanel';
import { AircraftData } from '../../../data/types';
import { StateManager } from '../../../core/StateManager';
import { logger } from '../../../utils/Logger';

export class TrafficListPanel extends BasePanel {
    private trafficListElement: HTMLElement | null = null;
    private stateManager: StateManager | null = null;
    private currentAircraftData: AircraftData | null = null;
    private selectedAircraft: string | null = null;
    private clickTimeouts: Map<string, number> = new Map();

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

        // Subscribe to selected aircraft changes from other sources (e.g., map clicks)
        this.stateManager.subscribe('selectedAircraft', (newAircraft, oldAircraft) => {
            this.selectedAircraft = newAircraft;
            this.updateSelectionVisuals();
        });

        // Subscribe to aircraft data updates
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
     * Update traffic list display
     */
    private updateTrafficList(): void {
        if (!this.trafficListElement || !this.currentAircraftData?.id) {
            if (this.trafficListElement) {
                this.trafficListElement.innerHTML = '';
            }
            return;
        }

        const data = this.currentAircraftData;

        // Filter out aircraft with empty or invalid IDs
        const validAircraft: string[] = [];
        const validIndices: number[] = [];

        for (let i = 0; i < data.id.length; i++) {
            const aircraftId = data.id[i];
            if (aircraftId && aircraftId.trim() !== '') {
                validAircraft.push(aircraftId);
                validIndices.push(i);
            }
        }

        // Get current items in the list
        const currentItems = Array.from(this.trafficListElement.children) as HTMLElement[];
        const newIds = validAircraft;

        // Remove items that no longer exist
        currentItems.forEach(item => {
            if (!newIds.includes(item.textContent || '')) {
                item.remove();
            }
        });

        // Add or update items
        validAircraft.forEach((aircraftId, idx) => {
            const originalIndex = validIndices[idx];

            // Check if item already exists
            let item = Array.from(this.trafficListElement!.children).find(
                child => child.textContent === aircraftId
            ) as HTMLElement;

            // Create new item if it doesn't exist
            if (!item) {
                item = document.createElement('div');
                item.className = 'traffic-item';
                item.textContent = aircraftId;

                // Add click and double-click listeners
                this.addAircraftClickHandlers(item, aircraftId, originalIndex);

                this.trafficListElement!.appendChild(item);
            }

            // Update selection state
            if (this.selectedAircraft === aircraftId) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });
    }

    /**
     * Update visual selection state for all traffic items
     */
    private updateSelectionVisuals(): void {
        if (!this.trafficListElement) return;

        const items = this.trafficListElement.querySelectorAll('.traffic-item');
        items.forEach(item => {
            const aircraftId = item.textContent;
            if (this.selectedAircraft === aircraftId) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });
    }

    /**
     * Add click handlers for aircraft items (single and double click)
     */
    private addAircraftClickHandlers(element: HTMLElement, aircraftId: string, index: number): void {
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
                this.handleAircraftDoubleClick(aircraftId, index);
            } else {
                // Single click - wait to see if there's a second click
                const timeout = window.setTimeout(() => {
                    clickCount = 0;
                    this.clickTimeouts.delete(aircraftId);
                    this.handleAircraftSingleClick(aircraftId, index);
                }, 300); // 300ms delay to detect double-click

                this.clickTimeouts.set(aircraftId, timeout);
            }
        });
    }

    /**
     * Handle single click on aircraft
     */
    private handleAircraftSingleClick(aircraftId: string, index: number): void {
        if (!this.stateManager) return;

        // Check if clicking the same aircraft that's already selected
        const isSameAircraft = this.selectedAircraft === aircraftId;

        if (isSameAircraft) {
            // Unselect aircraft
            this.stateManager.setSelectedAircraft(null);
            logger.debug('TrafficListPanel', `Unselected aircraft: ${aircraftId}`);
        } else {
            // Select new aircraft
            this.stateManager.setSelectedAircraft(aircraftId);
            logger.debug('TrafficListPanel', `Selected aircraft: ${aircraftId}`);

            // Emit custom event for map to handle zoom/pan
            const event = new CustomEvent('aircraft-single-click', {
                detail: { aircraftId, index }
            });
            document.dispatchEvent(event);
        }
    }

    /**
     * Handle double click on aircraft (zoom/follow behavior)
     */
    private handleAircraftDoubleClick(aircraftId: string, index: number): void {
        if (!this.stateManager) return;

        // Select aircraft
        this.stateManager.setSelectedAircraft(aircraftId);

        // Emit custom event for map to handle zoom/follow
        const event = new CustomEvent('aircraft-double-click', {
            detail: { aircraftId, index }
        });
        document.dispatchEvent(event);

        logger.debug('TrafficListPanel', `Double-clicked aircraft: ${aircraftId} - zooming/following`);
    }

    /**
     * Find aircraft index by ID
     */
    private findAircraftIndex(aircraftId: string): number {
        if (!this.currentAircraftData?.id) return -1;
        return this.currentAircraftData.id.indexOf(aircraftId);
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

    protected onDestroy(): void {
        // Clear all click timeouts
        this.clickTimeouts.forEach(timeout => clearTimeout(timeout));
        this.clickTimeouts.clear();
    }
}
