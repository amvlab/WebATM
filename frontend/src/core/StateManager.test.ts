/**
 * Characterization tests for StateManager: the app's central event bus.
 * Pins the subscribe/notify contract, the override-clearing policies,
 * reset() preservation rules, and the shape store behavior before the
 * shape store is extracted into its own module.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StateManager } from './StateManager';
import { AircraftData, PolyData, Shape, SimInfo } from '../data/types';

const aircraftData = (): AircraftData => ({
    id: ['KL123', 'AF265'],
    lat: [52.3, 48.8],
    lon: [4.8, 2.3],
    alt: [3000, 5000],
    tas: [250, 260],
    trk: [90, 180],
    vs: [0, -5],
    inconf: [false, true],
    tcpamax: [0, 42.5],
}) as unknown as AircraftData;

const poly = (name = 'zone1'): PolyData => ({
    name,
    lat: [52, 52.1, 52.2],
    lon: [4, 4.1, 4.2],
    color: '#ff0000',
});

describe('StateManager subscribe/notify', () => {
    let sm: StateManager;

    beforeEach(() => {
        sm = new StateManager();
    });

    it('notifies subscribers with new and old value on change', () => {
        const listener = vi.fn();
        sm.subscribe('selectedAircraft', listener);

        sm.setSelectedAircraft('KL123');
        expect(listener).toHaveBeenCalledWith('KL123', null);

        sm.setSelectedAircraft('AF265');
        expect(listener).toHaveBeenCalledWith('AF265', 'KL123');
    });

    it('does not notify when the value is unchanged (identity comparison)', () => {
        const listener = vi.fn();
        sm.subscribe('selectedAircraft', listener);

        sm.setSelectedAircraft('KL123');
        sm.setSelectedAircraft('KL123');
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('stops notifying after unsubscribe', () => {
        const listener = vi.fn();
        const unsubscribe = sm.subscribe('selectedAircraft', listener);

        unsubscribe();
        sm.setSelectedAircraft('KL123');
        expect(listener).not.toHaveBeenCalled();
    });

    it('a throwing listener does not prevent other listeners from running', () => {
        const bad = vi.fn(() => { throw new Error('boom'); });
        const good = vi.fn();
        sm.subscribe('selectedAircraft', bad);
        sm.subscribe('selectedAircraft', good);

        sm.setSelectedAircraft('KL123');
        expect(good).toHaveBeenCalledWith('KL123', null);
    });

    it('getState returns a shallow copy, not a live reference', () => {
        const snapshot = sm.getState();
        sm.setSelectedAircraft('KL123');
        expect(snapshot.selectedAircraft).toBeNull();
        expect(sm.getState().selectedAircraft).toBe('KL123');
    });
});

describe('StateManager display options and overrides', () => {
    let sm: StateManager;

    beforeEach(() => {
        sm = new StateManager();
    });

    it('merges partial display option updates and notifies', () => {
        const listener = vi.fn();
        sm.subscribe('displayOptions', listener);

        sm.updateDisplayOptions({ speedUnit: 'km/h' });

        expect(sm.getDisplayOptions().speedUnit).toBe('km/h');
        // Other options preserved
        expect(sm.getDisplayOptions().altitudeUnit).toBe('fl');
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('sets, reads, and clears per-aircraft model overrides', () => {
        const listener = vi.fn();
        sm.subscribe('aircraftModelOverrides', listener);

        sm.setAircraftModelOverride('KL123', 'B747.glb');
        expect(sm.getAircraftModelOverride('KL123')).toBe('B747.glb');
        expect(sm.getAircraftModelOverride('AF265')).toBeNull();

        sm.setAircraftModelOverride('KL123', null);
        expect(sm.getAircraftModelOverride('KL123')).toBeNull();
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('does not notify when an override is set to its current value', () => {
        const listener = vi.fn();
        sm.subscribe('aircraftModelOverrides', listener);

        sm.setAircraftModelOverride('KL123', 'B747.glb');
        sm.setAircraftModelOverride('KL123', 'B747.glb');
        sm.setAircraftModelOverride('AF265', null); // already absent
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('changing the global model selection wipes per-aircraft model overrides', () => {
        sm.setAircraftModelOverride('KL123', 'B747.glb');
        sm.updateDisplayOptions({ selectedAircraftModel: 'A320.glb' });
        expect(sm.getAircraftModelOverride('KL123')).toBeNull();
    });

    it('changing the global 3D scale wipes per-aircraft scale overrides', () => {
        sm.setAircraftScaleOverride('KL123', 3.5);
        expect(sm.getAircraftScaleOverride('KL123')).toBe(3.5);

        sm.updateDisplayOptions({ aircraft3DScale: 1.0 });
        expect(sm.getAircraftScaleOverride('KL123')).toBeNull();
    });

    it('unrelated display option changes leave overrides intact', () => {
        sm.setAircraftModelOverride('KL123', 'B747.glb');
        sm.updateDisplayOptions({ speedUnit: 'mph' });
        expect(sm.getAircraftModelOverride('KL123')).toBe('B747.glb');
    });
});

describe('StateManager aircraft lookups', () => {
    let sm: StateManager;

    beforeEach(() => {
        sm = new StateManager();
        sm.updateAircraftData(aircraftData());
    });

    it('getAircraftById returns the per-index record', () => {
        expect(sm.getAircraftById('AF265')).toEqual({
            id: 'AF265', lat: 48.8, lon: 2.3, alt: 5000, tas: 260,
            actype: '', trk: 180, vs: -5, inconf: true, tcpamax: 42.5,
        });
        expect(sm.getAircraftById('NOPE')).toBeNull();
    });

    it('getSelectedAircraftData follows the current selection', () => {
        expect(sm.getSelectedAircraftData()).toBeNull();
        sm.setSelectedAircraft('KL123');
        expect(sm.getSelectedAircraftData()?.lat).toBe(52.3);
    });

    it('getSimulationState maps the numeric state to a name', () => {
        expect(sm.getSimulationState()).toEqual({ state: 'UNKNOWN', speed: 0, time: 0 });
        sm.updateSimInfo({ state: 2, speed: 4, simt: 120, ntraf: 2 } as SimInfo);
        expect(sm.getSimulationState()).toEqual({ state: 'OP', speed: 4, time: 120 });
    });
});

describe('StateManager.reset', () => {
    let sm: StateManager;

    beforeEach(() => {
        sm = new StateManager();
    });

    it('preserves connection state and user preferences, clears simulation state', () => {
        sm.setConnectionStatus(true);
        sm.setBlueSkyConnectionStatus(true);
        sm.updateDisplayOptions({ speedUnit: 'km/h' });
        sm.updateAircraftData(aircraftData());
        sm.setSelectedAircraft('KL123');
        sm.setAircraftModelOverride('KL123', 'B747.glb');
        sm.addPolyData(poly());

        sm.reset();

        const state = sm.getState();
        expect(state.connected).toBe(true);
        expect(state.blueSkyConnected).toBe(true);
        expect(state.displayOptions.speedUnit).toBe('km/h');
        expect(state.aircraftData).toBeNull();
        expect(state.selectedAircraft).toBeNull();
        expect(state.aircraftModelOverrides).toEqual({});
        expect(sm.getShapeCount()).toBe(0);
    });

    it('notifies only the keys that actually changed', () => {
        sm.setConnectionStatus(true);
        sm.setSelectedAircraft('KL123');

        const connectedListener = vi.fn();
        const selectedListener = vi.fn();
        sm.subscribe('connected', connectedListener);
        sm.subscribe('selectedAircraft', selectedListener);

        sm.reset();

        expect(connectedListener).not.toHaveBeenCalled();
        expect(selectedListener).toHaveBeenCalledWith(null, 'KL123');
    });
});

describe('StateManager shape store', () => {
    let sm: StateManager;
    let shapeListener: ReturnType<typeof vi.fn<(shapes: Map<string, Shape>) => void>>;

    beforeEach(() => {
        sm = new StateManager();
        shapeListener = vi.fn<(shapes: Map<string, Shape>) => void>();
        sm.subscribeToShapes(shapeListener);
    });

    it('addShape stores by name and notifies with a copy of the map', () => {
        sm.addPolyData(poly('zone1'));

        expect(sm.getShapeCount()).toBe(1);
        expect(sm.getShape('zone1')?.type).toBe('polygon');
        expect(shapeListener).toHaveBeenCalledTimes(1);

        const received: Map<string, Shape> = shapeListener.mock.calls[0][0];
        received.delete('zone1');
        expect(sm.getShapeCount()).toBe(1); // internal map untouched
    });

    it('addShapes batches into a single notification', () => {
        sm.addShapes([
            sm.convertServerPolyToClientShape(poly('a')),
            sm.convertServerPolyToClientShape(poly('b')),
        ]);
        expect(sm.getShapeCount()).toBe(2);
        expect(shapeListener).toHaveBeenCalledTimes(1);
    });

    it('rejects poly data with missing or empty coordinate arrays', () => {
        sm.addPolyData({ name: 'bad', lat: [], lon: [] } as unknown as PolyData);
        sm.addPolyData({ name: 'worse' } as unknown as PolyData);
        expect(sm.getShapeCount()).toBe(0);
        expect(shapeListener).not.toHaveBeenCalled();
    });

    it('deleteShape notifies only when something was deleted', () => {
        sm.addPolyData(poly('zone1'));
        shapeListener.mockClear();

        expect(sm.deleteShape('zone1')).toBe(true);
        expect(sm.deleteShape('zone1')).toBe(false);
        expect(shapeListener).toHaveBeenCalledTimes(1);
    });

    it('setShapeVisibility notifies only on actual change', () => {
        sm.addPolyData(poly('zone1'));
        shapeListener.mockClear();

        sm.setShapeVisibility('zone1', true); // already visible
        expect(shapeListener).not.toHaveBeenCalled();

        sm.setShapeVisibility('zone1', false);
        expect(sm.getShape('zone1')?.visible).toBe(false);
        expect(shapeListener).toHaveBeenCalledTimes(1);
    });

    it('filters shapes by type and node', () => {
        sm.addPolyData(poly('zone1'), 'node-a');
        sm.addPolylineData({ name: 'line1', lat: [52, 53], lon: [4, 5] }, 'node-b');

        expect(sm.getShapesByType('polygon').map(s => s.name)).toEqual(['zone1']);
        expect(sm.getShapesByNode('node-b').map(s => s.name)).toEqual(['line1']);
    });

    it('clearShapesForNode removes only that node\'s shapes', () => {
        sm.addPolyData(poly('zone1'), 'node-a');
        sm.addPolyData(poly('zone2'), 'node-b');

        sm.clearShapesForNode('node-a');

        expect(sm.getShape('zone1')).toBeUndefined();
        expect(sm.getShape('zone2')).toBeDefined();
    });

    it('switching the active node clears shapes; the initial node does not', () => {
        sm.addPolyData(poly('zone1'));

        sm.setActiveNode('node-a'); // initial: null -> node-a
        expect(sm.getShapeCount()).toBe(1);

        sm.setActiveNode('node-b'); // actual switch
        expect(sm.getShapeCount()).toBe(0);
    });
});

describe('StateManager server shape conversion', () => {
    let sm: StateManager;

    beforeEach(() => {
        sm = new StateManager();
    });

    it('converts PolyData into a polygon shape with paired coordinates', () => {
        const shape = sm.convertServerPolyToClientShape(poly('zone1'), 'node-a');
        expect(shape).toMatchObject({
            type: 'polygon',
            name: 'zone1',
            visible: true,
            nodeId: 'node-a',
            fillColor: '#ff0000',
            fillOpacity: 0.2,
            strokeColor: '#ff0000',
            strokeWidth: 2,
        });
        expect(shape.coordinates).toEqual([
            { lat: 52, lng: 4 },
            { lat: 52.1, lng: 4.1 },
            { lat: 52.2, lng: 4.2 },
        ]);
    });

    it('converts PolylineData into a polyline shape with a default width', () => {
        const shape = sm.convertServerPolylineToClientShape(
            { name: 'line1', lat: [52, 53], lon: [4, 5], color: '#00ff00' }
        );
        expect(shape).toMatchObject({
            type: 'polyline',
            name: 'line1',
            color: '#00ff00',
            width: 2,
        });
    });

    it('falls back to an empty-coordinate shape for invalid input', () => {
        const shape = sm.convertServerPolyToClientShape({ name: 'bad' } as unknown as PolyData);
        expect(shape.coordinates).toEqual([]);
        expect(shape.name).toBe('bad');
        // Invalid input uses the same fill opacity as valid input, so the
        // display toggle (not per-shape data) governs fill visibility.
        expect(shape.fillOpacity).toBe(0.2);

        const unnamed = sm.convertServerPolyToClientShape({} as unknown as PolyData);
        expect(unnamed.name).toBe('unnamed');
    });
});
