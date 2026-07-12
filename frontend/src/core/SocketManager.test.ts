// @vitest-environment happy-dom
/**
 * Tests for SocketManager's handling of the `initial_data` snapshot and the
 * poly/polyline shape events, against a mocked socket.io client.
 *
 * The snapshot field names must match the backend payload built by
 * `DataManager.get_current_data()` (`sim_data`, `traffic_data`, ...), and
 * fields cleared to `{}` on proxy disconnect must be treated as absent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type EventCallback = (data: unknown) => void;

const mockSocket = vi.hoisted(() => ({
    listeners: new Map<string, EventCallback>(),
    on(event: string, cb: EventCallback) {
        this.listeners.set(event, cb);
    },
    fire(event: string, data?: unknown) {
        this.listeners.get(event)?.(data);
    },
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(),
    connected: true,
}));

vi.mock('socket.io-client', () => ({
    io: vi.fn(() => mockSocket),
}));

import { SocketManager } from './SocketManager';
import { StateManager } from './StateManager';
import { AircraftData, SimInfo } from '../data/types';

const simInfo = (): SimInfo => ({
    speed: 1, simdt: 0.05, simt: 10, simutc: '', ntraf: 1, state: 2, scenname: 'test',
}) as unknown as SimInfo;

const aircraftData = (): AircraftData => ({
    id: ['KL204'], lat: [52.3], lon: [4.8], alt: [3000], tas: [250], trk: [90], vs: [0],
}) as unknown as AircraftData;

describe('SocketManager initial_data snapshot', () => {
    let stateManager: StateManager;

    beforeEach(() => {
        mockSocket.listeners.clear();
        stateManager = new StateManager();
        new SocketManager(stateManager);
    });

    it('applies sim_data and traffic_data from the snapshot', () => {
        mockSocket.fire('initial_data', {
            sim_data: simInfo(),
            traffic_data: aircraftData(),
        });

        expect(stateManager.getState().simInfo?.scenname).toBe('test');
        expect(stateManager.getState().aircraftData?.id).toEqual(['KL204']);
    });

    it('ignores fields cleared to empty objects (proxy disconnected)', () => {
        mockSocket.fire('initial_data', {
            sim_data: {},
            traffic_data: {},
            cmddict: {},
            poly_data: {},
            polyline_data: {},
        });

        expect(stateManager.getState().simInfo).toBeNull();
        expect(stateManager.getState().aircraftData).toBeNull();
        expect(stateManager.getState().cmddict).toBeNull();
        expect(stateManager.getShapeCount()).toBe(0);
    });

    it('loads cmddict and batched shapes from the snapshot', () => {
        mockSocket.fire('initial_data', {
            cmddict: { CRE: { help: 'create' } },
            poly_data: { polys: { zone1: { name: 'zone1', lat: [52, 52.1, 52.2], lon: [4, 4.1, 4.2] } } },
            polyline_data: { polys: { line1: { name: 'line1', lat: [52, 53], lon: [4, 5] } } },
        });

        expect(stateManager.getState().cmddict).toHaveProperty('CRE');
        expect(stateManager.getShape('zone1')?.type).toBe('polygon');
        expect(stateManager.getShape('line1')?.type).toBe('polyline');
    });
});

describe('SocketManager shape events', () => {
    let stateManager: StateManager;

    beforeEach(() => {
        mockSocket.listeners.clear();
        stateManager = new StateManager();
        new SocketManager(stateManager);
    });

    it('stores valid shapes from a poly dictionary payload and skips invalid ones', () => {
        mockSocket.fire('poly', {
            polys: {
                good: { name: 'good', lat: [52, 52.1, 52.2], lon: [4, 4.1, 4.2] },
                bad: { name: 'bad', lat: [], lon: [] },
            },
        });

        expect(stateManager.getShape('good')).toBeDefined();
        expect(stateManager.getShape('bad')).toBeUndefined();
    });

    it('ignores an empty polyline envelope', () => {
        mockSocket.fire('polyline', { polys: {} });
        expect(stateManager.getShapeCount()).toBe(0);
    });
});
