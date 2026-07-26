// @vitest-environment happy-dom
/**
 * Tests for the Aircraft Info panel's click-to-copy: the copied value
 * must come back after the "Copied!" flash even when no data tick
 * arrives, a second click during the flash must copy the real value
 * (never the feedback label), and a hovered field freezes its displayed
 * value so live-updating data isn't a moving target to copy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AircraftInfoPanel } from './AircraftInfoPanel';
import { StateManager } from '../../../core/StateManager';
import { AircraftData } from '../../../data/types';
import { resetAircraftModelsCache } from '../../../data/aircraftModels';

const aircraft = (entries: Array<{ id: string; actype?: string }>): AircraftData =>
    ({
        id: entries.map(e => e.id),
        actype: entries.map(e => e.actype ?? 'B744'),
        lat: entries.map(() => 52.3),
        lon: entries.map(() => 4.76),
        alt: entries.map(() => 3000),
        cas: entries.map(() => 250),
        tas: entries.map(() => 280),
        gs: entries.map(() => 275),
        trk: entries.map(() => 90),
        vs: entries.map(() => 0),
        inconf: entries.map(() => false),
        tcpamax: entries.map(() => 0),
    }) as AircraftData;

describe('AircraftInfoPanel click-to-copy', () => {
    let panel: AircraftInfoPanel;
    let stateManager: StateManager;
    let info: HTMLElement;
    let writeText: ReturnType<typeof vi.fn>;

    const field = (name: string) =>
        info.querySelector(`[data-field="${name}"]`) as HTMLElement;

    const clickCopy = async (name: string): Promise<HTMLElement> => {
        const el = field(name);
        el.click();
        // Flush the async clipboard write inside the click handler
        await vi.advanceTimersByTimeAsync(0);
        return el;
    };

    beforeEach(() => {
        vi.useFakeTimers();
        resetAircraftModelsCache();
        // Model-catalog fetch fails fast; the copy fields don't need it
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
        writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(window.navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        });

        document.body.innerHTML = `
            <div class="aircraft-panel">
                <div class="panel-content" id="aircraft-info-content">
                    <div id="aircraft-info"></div>
                </div>
            </div>
        `;
        info = document.getElementById('aircraft-info')!;
        stateManager = new StateManager();
        panel = new AircraftInfoPanel();
        panel.init();
        panel.setStateManager(stateManager);

        stateManager.updateAircraftData(aircraft([{ id: 'KL123' }]));
        stateManager.setSelectedAircraft('KL123');
    });

    afterEach(() => {
        panel.destroy();
        document.body.innerHTML = '';
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('copies the field value and shows feedback', async () => {
        const el = await clickCopy('id');

        expect(writeText).toHaveBeenCalledWith('KL123');
        expect(el.textContent).toBe('Copied!');
    });

    it('restores the value after the feedback even without a data tick', async () => {
        // Paused simulation: no aircraftData update arrives during the flash
        const el = await clickCopy('id');
        await vi.advanceTimersByTimeAsync(1000);

        expect(el.textContent).toBe('KL123');
    });

    it('copies the real value when clicked again during the feedback', async () => {
        await clickCopy('id');
        await vi.advanceTimersByTimeAsync(300);
        const el = await clickCopy('id');

        expect(writeText).toHaveBeenLastCalledWith('KL123');
        expect(writeText).not.toHaveBeenCalledWith('Copied!');
        // Feedback restarted; still restores afterwards
        await vi.advanceTimersByTimeAsync(1000);
        expect(el.textContent).toBe('KL123');
    });

    it('restores the freshest value received during the feedback', async () => {
        const el = await clickCopy('actype');
        expect(el.textContent).toBe('Copied!');

        // A data tick during the flash must not clobber the feedback...
        stateManager.updateAircraftData(aircraft([{ id: 'KL123', actype: 'B77W' }]));
        expect(el.textContent).toBe('Copied!');

        // ...but its value is what gets restored
        await vi.advanceTimersByTimeAsync(1000);
        expect(el.textContent).toBe('B77W');
    });

    it('freezes a hovered field while data ticks arrive', () => {
        const el = field('actype');
        el.dispatchEvent(new MouseEvent('mouseenter'));

        stateManager.updateAircraftData(aircraft([{ id: 'KL123', actype: 'B77W' }]));
        expect(el.textContent).toBe('B744');

        el.dispatchEvent(new MouseEvent('mouseleave'));
        expect(el.textContent).toBe('B77W');
    });

    it('copies the frozen value shown under the cursor', async () => {
        const el = field('actype');
        el.dispatchEvent(new MouseEvent('mouseenter'));
        stateManager.updateAircraftData(aircraft([{ id: 'KL123', actype: 'B77W' }]));

        await clickCopy('actype');

        // What was on screen, not the newer value that ticked in under it
        expect(writeText).toHaveBeenCalledWith('B744');
        await vi.advanceTimersByTimeAsync(1000);
        expect(el.textContent).toBe('B77W');
    });
});
