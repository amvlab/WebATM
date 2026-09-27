// @vitest-environment happy-dom
/**
 * Tests for AircraftInteractionManager panel-event handling — cleanup on
 * destroy() (the document-level listeners used to outlive the map), the
 * unselect path (stop follow mode, toggle the route broadcast off) — and
 * the empty-map-click unselect, which must hit-test synchronously (a
 * deferred check used to misread aircraft clicks as empty-map clicks once
 * the camera or the aircraft had moved off the clicked point).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AircraftInteractionManager } from './AircraftInteractionManager';
import { StateManager } from '../../../core/StateManager';
import type { MapDisplay } from '../MapDisplay';
import type { SocketManager } from '../../../core/SocketManager';
import type { AircraftData } from '../../../data/types';

// `once` invokes its callback immediately so the zoom/follow animation
// chain completes synchronously under fake timers.
const stubMap = () => {
    const canvas = { style: { cursor: '' } };
    return {
        on: vi.fn(),
        once: vi.fn((_event: string, cb: () => void) => cb()),
        getLayer: vi.fn(() => ({ id: 'aircraft-points' })),
        queryRenderedFeatures: vi.fn((): unknown[] => []),
        getZoom: vi.fn(() => 8),
        easeTo: vi.fn(),
        flyTo: vi.fn(),
        canvas,
        getCanvas: vi.fn(() => canvas),
    };
};
type StubMap = ReturnType<typeof stubMap>;

// The generic (non-layer) handler registered for a map event.
const mapHandler = (map: StubMap, event: string): ((e: unknown) => void) => {
    const call = map.on.mock.calls.find(
        (c: unknown[]) => c[0] === event && typeof c[1] === 'function'
    );
    if (!call) throw new Error(`no generic ${event} handler registered`);
    return call[1] as (e: unknown) => void;
};

// The handler delegated to the aircraft-points layer for a map event.
const layerHandler = (map: StubMap, event: string): ((e: unknown) => void) => {
    const call = map.on.mock.calls.find(
        (c: unknown[]) => c[0] === event && c[1] === 'aircraft-points'
    );
    if (!call) throw new Error(`no aircraft-points ${event} handler registered`);
    return call[2] as (e: unknown) => void;
};

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
    let map: StubMap;

    beforeEach(() => {
        sendCommand = vi.fn();
        stateManager = new StateManager();
        map = stubMap();
        manager = new AircraftInteractionManager(
            { getMap: () => map } as unknown as MapDisplay,
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

    it('empty-map click unselects, stops following and toggles the route off', () => {
        vi.useFakeTimers();
        stateManager.updateAircraftData(aircraft(['KL123']));
        stateManager.setSelectedAircraft('KL123');
        // Panel double-click starts follow mode once the animations finish
        panelEvent('aircraft-double-click', 'KL123');
        vi.advanceTimersByTime(200);
        expect(manager.getFollowingAircraft()).toBe('KL123');
        sendCommand.mockClear();

        map.queryRenderedFeatures.mockReturnValue([]);
        mapHandler(map, 'click')({ point: { x: 10, y: 10 } });

        expect(stateManager.getState().selectedAircraft).toBeNull();
        expect(manager.getFollowingAircraft()).toBeNull();
        expect(sendCommand).toHaveBeenCalledWith('POS KL123');
        vi.useRealTimers();
    });

    it('does not unselect when the click hit an aircraft, even if it later moves off the point', () => {
        vi.useFakeTimers();
        stateManager.updateAircraftData(aircraft(['KL123']));
        stateManager.setSelectedAircraft('KL123');

        // At click time the point is on the aircraft; the select-triggered
        // flyTo (or a data update) then moves it away. The old deferred
        // re-query saw the empty point and spuriously unselected.
        map.queryRenderedFeatures.mockReturnValueOnce([{ properties: { entity_id: 'KL123' } }]);
        mapHandler(map, 'click')({ point: { x: 10, y: 10 } });
        vi.advanceTimersByTime(1000);

        expect(stateManager.getState().selectedAircraft).toBe('KL123');
        vi.useRealTimers();
    });

    it("toggles the old aircraft's route broadcast off when selection switches between aircraft", () => {
        stateManager.updateAircraftData(aircraft(['KL123', 'KL456']));
        stateManager.setSelectedAircraft('KL123');
        sendCommand.mockClear();

        stateManager.setSelectedAircraft('KL456');
        expect(sendCommand).toHaveBeenCalledWith('POS KL123');

        // Plain unselect paths send their own toggle; the subscription
        // must not add a second one (which would toggle the route back on).
        sendCommand.mockClear();
        stateManager.setSelectedAircraft(null);
        expect(sendCommand).not.toHaveBeenCalled();
    });

    it('ignores empty-map clicks while a drawing tool is active', () => {
        stateManager.updateAircraftData(aircraft(['KL123']));
        stateManager.setSelectedAircraft('KL123');
        manager.setDrawingToolActiveCheck(() => true);

        map.queryRenderedFeatures.mockReturnValue([]);
        mapHandler(map, 'click')({ point: { x: 10, y: 10 } });

        expect(stateManager.getState().selectedAircraft).toBe('KL123');
    });

    it('aircraft-icon click selects the aircraft and flies to it when no draw is active', () => {
        stateManager.updateAircraftData(aircraft(['KL123', 'PH456']));
        stateManager.setSelectedAircraft('KL123');

        layerHandler(map, 'click')({ features: [{ properties: { entity_id: 'PH456' } }] });

        expect(stateManager.getState().selectedAircraft).toBe('PH456');
        expect(map.flyTo).toHaveBeenCalled();
    });

    it('ignores aircraft-icon clicks while a drawing tool is active (the click is a point placement)', () => {
        stateManager.updateAircraftData(aircraft(['KL123', 'PH456']));
        stateManager.setSelectedAircraft('KL123');
        manager.setDrawingToolActiveCheck(() => true);
        sendCommand.mockClear();

        // Clicking another aircraft must not steal the selection or move the camera...
        layerHandler(map, 'click')({ features: [{ properties: { entity_id: 'PH456' } }] });
        // ...and clicking the selected route target must not unselect it.
        layerHandler(map, 'click')({ features: [{ properties: { entity_id: 'KL123' } }] });
        layerHandler(map, 'dblclick')({ features: [{ properties: { entity_id: 'PH456' } }] });

        expect(stateManager.getState().selectedAircraft).toBe('KL123');
        expect(map.flyTo).not.toHaveBeenCalled();
        expect(map.easeTo).not.toHaveBeenCalled();
        expect(sendCommand).not.toHaveBeenCalled();
    });

    it('keeps the drawing crosshair cursor when hovering an aircraft mid-draw', () => {
        manager.setDrawingToolActiveCheck(() => true);
        map.canvas.style.cursor = 'crosshair';

        layerHandler(map, 'mouseenter')({});
        expect(map.canvas.style.cursor).toBe('crosshair');
        layerHandler(map, 'mouseleave')({});
        expect(map.canvas.style.cursor).toBe('crosshair');
    });

    it('swaps the hover cursor normally when no draw is active', () => {
        layerHandler(map, 'mouseenter')({});
        expect(map.canvas.style.cursor).toBe('pointer');
        layerHandler(map, 'mouseleave')({});
        expect(map.canvas.style.cursor).toBe('');
    });
});
