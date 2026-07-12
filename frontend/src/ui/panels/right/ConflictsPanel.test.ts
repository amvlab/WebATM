// @vitest-environment happy-dom
/**
 * Characterization tests for the Conflicts panel: conflict list rendering,
 * the rebuild-only-on-change optimization, and live TCPA refresh (the TCPA
 * used to freeze at its first value while the conflict set was unchanged).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConflictsPanel } from './ConflictsPanel';
import { StateManager } from '../../../core/StateManager';
import { AircraftData } from '../../../data/types';

const aircraft = (
    entries: Array<{ id: string; inconf?: boolean; tcpa?: number }>
): AircraftData =>
    ({
        id: entries.map(e => e.id),
        lat: entries.map(() => 52),
        lon: entries.map(() => 4),
        alt: entries.map(() => 3000),
        tas: entries.map(() => 200),
        inconf: entries.map(e => e.inconf ?? false),
        tcpamax: entries.map(e => e.tcpa ?? 0),
    }) as AircraftData;

describe('ConflictsPanel', () => {
    let panel: ConflictsPanel;
    let stateManager: StateManager;
    let info: HTMLElement;

    const items = () => Array.from(info.querySelectorAll('.conflict-item')) as HTMLElement[];
    const tcpaTexts = () =>
        Array.from(info.querySelectorAll('.conflict-tcpa')).map(el => el.textContent?.trim());

    beforeEach(() => {
        document.body.innerHTML = `
            <div class="conflicts-panel">
                <div class="panel-content" id="conflicts-content">
                    <div id="conflicts-info">
                        <div class="no-conflicts">No conflicts detected</div>
                    </div>
                </div>
            </div>
        `;
        info = document.getElementById('conflicts-info')!;
        stateManager = new StateManager();
        panel = new ConflictsPanel();
        panel.init();
        panel.setStateManager(stateManager);
    });

    afterEach(() => {
        panel.destroy();
        document.body.innerHTML = '';
    });

    it('lists only aircraft in conflict, with their TCPA', () => {
        stateManager.updateAircraftData(aircraft([
            { id: 'KL123', inconf: true, tcpa: 42.58 },
            { id: 'AF265' },
            { id: 'BA042', inconf: true, tcpa: 12.3 },
        ]));

        expect(items().map(el => el.dataset.aircraftId)).toEqual(['KL123', 'BA042']);
        expect(tcpaTexts()).toEqual(['TCPA: 42.6s', 'TCPA: 12.3s']);
    });

    it('shows a TCPA of zero instead of dropping it', () => {
        stateManager.updateAircraftData(aircraft([{ id: 'KL123', inconf: true, tcpa: 0 }]));
        expect(tcpaTexts()).toEqual(['TCPA: 0.0s']);
    });

    it('refreshes TCPA in place while the conflict set is unchanged', () => {
        stateManager.updateAircraftData(aircraft([{ id: 'KL123', inconf: true, tcpa: 30 }]));
        const item = items()[0];

        stateManager.updateAircraftData(aircraft([{ id: 'KL123', inconf: true, tcpa: 25.4 }]));

        expect(tcpaTexts()).toEqual(['TCPA: 25.4s']);
        // The DOM item was reused, not rebuilt
        expect(items()[0]).toBe(item);
    });

    it('rebuilds the list when the conflict set changes', () => {
        stateManager.updateAircraftData(aircraft([{ id: 'KL123', inconf: true, tcpa: 30 }]));
        stateManager.updateAircraftData(aircraft([
            { id: 'KL123', inconf: true, tcpa: 28 },
            { id: 'BA042', inconf: true, tcpa: 15 },
        ]));

        expect(items().map(el => el.dataset.aircraftId)).toEqual(['KL123', 'BA042']);
    });

    it('shows the empty state again when all conflicts resolve', () => {
        stateManager.updateAircraftData(aircraft([{ id: 'KL123', inconf: true, tcpa: 30 }]));
        stateManager.updateAircraftData(aircraft([{ id: 'KL123' }]));

        expect(items()).toEqual([]);
        expect(info.querySelector('.no-conflicts')).not.toBeNull();
    });

    it('stops reacting to state changes after destroy', () => {
        stateManager.updateAircraftData(aircraft([{ id: 'KL123', inconf: true, tcpa: 30 }]));
        panel.destroy();

        stateManager.updateAircraftData(aircraft([
            { id: 'KL123', inconf: true, tcpa: 28 },
            { id: 'BA042', inconf: true, tcpa: 15 },
        ]));
        expect(items().map(el => el.dataset.aircraftId)).toEqual(['KL123']);
    });

    it('highlights the selected aircraft', () => {
        stateManager.updateAircraftData(aircraft([
            { id: 'KL123', inconf: true, tcpa: 30 },
            { id: 'BA042', inconf: true, tcpa: 15 },
        ]));

        stateManager.setSelectedAircraft('BA042');
        const selected = info.querySelector('.conflict-item.selected') as HTMLElement;
        expect(selected.dataset.aircraftId).toBe('BA042');
    });
});
