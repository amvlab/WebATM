// @vitest-environment happy-dom
/**
 * Characterization tests for the Traffic List panel: list reconciliation
 * against aircraft data updates and selection highlighting.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TrafficListPanel } from './TrafficListPanel';
import { StateManager } from '../../../core/StateManager';
import { AircraftData } from '../../../data/types';

const aircraft = (ids: string[]): AircraftData =>
    ({
        id: ids,
        lat: ids.map(() => 52),
        lon: ids.map(() => 4),
        alt: ids.map(() => 3000),
        tas: ids.map(() => 200),
    }) as AircraftData;

describe('TrafficListPanel', () => {
    let panel: TrafficListPanel;
    let stateManager: StateManager;
    let list: HTMLElement;

    const itemTexts = () =>
        Array.from(list.querySelectorAll('.traffic-item')).map(el => el.textContent);

    beforeEach(() => {
        document.body.innerHTML = `
            <div class="traffic-panel">
                <div class="panel-content" id="traffic-content">
                    <div id="traffic-list"></div>
                </div>
            </div>
        `;
        list = document.getElementById('traffic-list')!;
        stateManager = new StateManager();
        panel = new TrafficListPanel();
        panel.init();
        panel.setStateManager(stateManager);
    });

    afterEach(() => {
        panel.destroy();
        document.body.innerHTML = '';
    });

    it('renders one item per aircraft, skipping blank IDs', () => {
        stateManager.updateAircraftData(aircraft(['KL123', '', '  ', 'AF265']));
        expect(itemTexts()).toEqual(['KL123', 'AF265']);
    });

    it('removes items for deleted aircraft and keeps existing elements', () => {
        stateManager.updateAircraftData(aircraft(['KL123', 'AF265', 'BA042']));
        const kept = list.querySelector('.traffic-item')!;

        stateManager.updateAircraftData(aircraft(['KL123', 'BA042']));

        expect(itemTexts()).toEqual(['KL123', 'BA042']);
        // The KL123 element survives reconciliation (its listeners stay attached)
        expect(list.querySelector('.traffic-item')).toBe(kept);
    });

    it('clears the list when aircraft data has no IDs', () => {
        stateManager.updateAircraftData(aircraft(['KL123']));
        stateManager.updateAircraftData(aircraft([]));
        expect(itemTexts()).toEqual([]);
    });

    it('highlights the selected aircraft and clears it on unselect', () => {
        stateManager.updateAircraftData(aircraft(['KL123', 'AF265']));

        stateManager.setSelectedAircraft('AF265');
        expect(itemTexts()).toEqual(['KL123', 'AF265']);
        expect(list.querySelector('.traffic-item.selected')?.textContent).toBe('AF265');

        stateManager.setSelectedAircraft(null);
        expect(list.querySelector('.traffic-item.selected')).toBeNull();
    });

    it('keeps the selection highlight across data updates', () => {
        stateManager.updateAircraftData(aircraft(['KL123', 'AF265']));
        stateManager.setSelectedAircraft('KL123');

        stateManager.updateAircraftData(aircraft(['KL123', 'AF265', 'BA042']));
        expect(list.querySelector('.traffic-item.selected')?.textContent).toBe('KL123');
    });

    it('stops reacting to state changes after destroy', () => {
        stateManager.updateAircraftData(aircraft(['KL123']));
        panel.destroy();

        stateManager.updateAircraftData(aircraft(['KL123', 'AF265']));
        expect(itemTexts()).toEqual(['KL123']);

        stateManager.setSelectedAircraft('KL123');
        expect(list.querySelector('.traffic-item.selected')).toBeNull();
    });

    it('clicking an item selects the aircraft through the state manager', async () => {
        stateManager.updateAircraftData(aircraft(['KL123']));
        (list.querySelector('.traffic-item') as HTMLElement).click();

        await new Promise(resolve => setTimeout(resolve, 350));
        expect(stateManager.getState().selectedAircraft).toBe('KL123');
    });
});
