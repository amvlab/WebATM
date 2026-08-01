// @vitest-environment happy-dom
/**
 * Tests for AircraftInteractionManager panel-event handling: cleanup on
 * destroy() (the document-level listeners used to outlive the map) and
 * the unselect path (stop follow mode, toggle the route broadcast off).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AircraftInteractionManager } from './AircraftInteractionManager';
import { StateManager } from '../../../core/StateManager';
import type { MapDisplay } from '../MapDisplay';
import type { SocketManager } from '../../../core/SocketManager';
import type { AircraftData } from '../../../data/types';

// `once` invokes its callback immediately so the zoom/follow animation
// chain completes synchronously under fake timers.
const stubMap = () => ({
    on: vi.fn(),
    once: vi.fn((_event: string, cb: () => void) => cb()),
    getLayer: vi.fn(() => undefined),
    queryRenderedFeatures: vi.fn(() => []),
    getZoom: vi.fn(() => 8),
    easeTo: vi.fn(),
    flyTo: vi.fn(),
    getCanvas: vi.fn(() => ({ style: {} })),
});

const panelEvent = (type: 'aircraft-single-click' | 'aircraft-double-click' | 'aircraft-unselect', aircraftId: string) =>
    document.dispatchEvent(new CustomEvent(type, { detail: { aircraftId } }));

const aircraft = (ids: string[]): AircraftData =>
    ({
        id: ids,
        lat: ids.map(() => 52),
        lon: ids.map(() => 4),
        alt: ids.map(() => 3000),
        tas: ids.map(() => 200),
        trk: ids.map(() => 90),
        vs: ids.map(() => 0),
        inconf: ids.map(() => false),
        tcpamax: ids.map(() => 0),
    }) as AircraftData;

describe('AircraftInteractionManager', () => {
    let manager: AircraftInteractionManager;
    let stateManager: StateManager;
    let sendCommand: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        sendCommand = vi.fn();
        stateManager = new StateManager();
        manager = new AircraftInteractionManager(
            { getMap: () => stubMap() } as unknown as MapDisplay,
            stateManager,
            { sendCommand } as unknown as SocketManager,
        );
    });

    afterEach(() => {
        manager.destroy();
    });

    it('requests route data when a panel single-click event arrives', () => {
        panelEvent('aircraft-single-click', 'KL123');
        expect(sendCommand).toHaveBeenCalledWith('POS KL123');
    });

    it('stops listening to panel click events after destroy', () => {
        manager.destroy();
        panelEvent('aircraft-single-click', 'KL123');
        expect(sendCommand).not.toHaveBeenCalled();
    });

    it('panel unselect stops follow mode and re-sends POS to toggle the route off', () => {
        vi.useFakeTimers();
        stateManager.updateAircraftData(aircraft(['KL123']));

        // Panel double-click starts follow mode once the animations finish
        panelEvent('aircraft-double-click', 'KL123');
        vi.advanceTimersByTime(200);
        expect(manager.getFollowingAircraft()).toBe('KL123');

        sendCommand.mockClear();
        panelEvent('aircraft-unselect', 'KL123');

        expect(manager.getFollowingAircraft()).toBeNull();
        expect(sendCommand).toHaveBeenCalledWith('POS KL123');
        vi.useRealTimers();
    });
});
