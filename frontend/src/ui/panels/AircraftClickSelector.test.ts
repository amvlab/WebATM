// @vitest-environment happy-dom
/**
 * Tests for the shared single/double-click aircraft selection used by the
 * traffic and conflicts panels.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AircraftClickSelector } from './AircraftClickSelector';
import type { StateManager } from '../../core/StateManager';

function createStateManagerMock(selected: string | null = null) {
    const state = { selectedAircraft: selected };
    return {
        state,
        getState: () => state,
        setSelectedAircraft: vi.fn((id: string | null) => {
            state.selectedAircraft = id;
        }),
    };
}

describe('AircraftClickSelector', () => {
    let stateManager: ReturnType<typeof createStateManagerMock>;
    let selector: AircraftClickSelector;
    let item: HTMLElement;

    beforeEach(() => {
        vi.useFakeTimers();
        stateManager = createStateManagerMock();
        selector = new AircraftClickSelector(
            'TestPanel',
            () => stateManager as unknown as StateManager
        );
        item = document.createElement('div');
        document.body.appendChild(item);
        selector.attach(item, 'KL123', 0);
    });

    afterEach(() => {
        selector.dispose();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('single click selects after the double-click window and pans', () => {
        const panEvent = vi.fn();
        document.addEventListener('aircraft-single-click', panEvent);

        item.click();
        expect(stateManager.setSelectedAircraft).not.toHaveBeenCalled();

        vi.advanceTimersByTime(300);
        expect(stateManager.setSelectedAircraft).toHaveBeenCalledWith('KL123');
        expect(panEvent).toHaveBeenCalledTimes(1);
        expect((panEvent.mock.calls[0][0] as CustomEvent).detail)
            .toEqual({ aircraftId: 'KL123', index: 0 });
    });

    it('single click on the already-selected aircraft unselects without panning', () => {
        stateManager.state.selectedAircraft = 'KL123';
        const panEvent = vi.fn();
        document.addEventListener('aircraft-single-click', panEvent);

        item.click();
        vi.advanceTimersByTime(300);

        expect(stateManager.setSelectedAircraft).toHaveBeenCalledWith(null);
        expect(panEvent).not.toHaveBeenCalled();
    });

    it('double click cancels the pending single click and dispatches zoom/follow', () => {
        const singleEvent = vi.fn();
        const doubleEvent = vi.fn();
        document.addEventListener('aircraft-single-click', singleEvent);
        document.addEventListener('aircraft-double-click', doubleEvent);

        item.click();
        item.click();
        vi.advanceTimersByTime(400);

        expect(stateManager.setSelectedAircraft).toHaveBeenCalledTimes(1);
        expect(stateManager.setSelectedAircraft).toHaveBeenCalledWith('KL123');
        expect(doubleEvent).toHaveBeenCalledTimes(1);
        expect(singleEvent).not.toHaveBeenCalled();
    });

    it('dispose cancels pending single-click timers', () => {
        item.click();
        selector.dispose();
        vi.advanceTimersByTime(400);
        expect(stateManager.setSelectedAircraft).not.toHaveBeenCalled();
    });
});
