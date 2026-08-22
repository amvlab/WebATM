/**
 * Tests for Aircraft3DCustomLayer.updateAircraft removal handling.
 *
 * Focus: an empty aircraft batch (the last aircraft was deleted) must still
 * fall through to the removal loop so the deleted aircraft's 3D mesh is torn
 * down. A previous early-return on `id.length === 0` left it on the map as a
 * ghost until the next non-empty tick or a full reset.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AircraftData, DisplayOptions } from '../../../data/types';

// Base class: only the members updateAircraft touches, plus a settable scene.
vi.mock('../rendering/CustomLayer3D', () => ({
    CustomLayer3D: class {
        id: string;
        scene: unknown = undefined;
        camera = {};
        renderer = { capabilities: { getMaxAnisotropy: () => 16 } };
        map = null;
        constructor(id: string) {
            this.id = id;
        }
        createTransformMatrix() {
            return {};
        }
        isGlobeProjection() {
            return false;
        }
    },
}));

// Stateful fake fleet: tracks live ids and records remove() calls.
const fleetState = new Map<string, { modelPath: string }>();
const removeCalls: string[] = [];
vi.mock('./Aircraft3DFleet', () => ({
    Aircraft3DFleet: class {
        constructor(_deps: unknown) {}
        get(id: string) {
            return fleetState.get(id);
        }
        create(id: string, _data: unknown, modelPath: string) {
            fleetState.set(id, { modelPath });
        }
        remove(id: string) {
            removeCalls.push(id);
            fleetState.delete(id);
        }
        update() {}
        forEach(cb: (entry: unknown, id: string) => void) {
            fleetState.forEach((entry, id) => cb(entry, id));
        }
        refreshPending() {}
        prunePending() {}
        reapplyAllTransforms() {}
    },
}));

vi.mock('./Aircraft3DModelLoader', () => ({
    Aircraft3DModelLoader: class {
        constructor(_opts: unknown) {}
        hasFailed() {
            return false;
        }
        load() {}
        clearCache() {}
        clearAll() {}
    },
}));

vi.mock('./Aircraft3DTransforms', () => ({
    Aircraft3DTransforms: class {
        constructor(_deps: unknown) {}
        updateSceneOrigin() {
            return false;
        }
        updateMeshTransform() {}
    },
}));

import { Aircraft3DCustomLayer } from './Aircraft3DCustomLayer';

function makeLayer(): Aircraft3DCustomLayer {
    const layer = new Aircraft3DCustomLayer(
        { selectedAircraftModel: 'auto' } as DisplayOptions,
        null
    );
    // Mark the scene ready so updateAircraft processes instead of queuing.
    (layer as unknown as { scene: object }).scene = {};
    return layer;
}

function batch(ids: string[]): AircraftData {
    return {
        id: ids,
        lat: ids.map(() => 52),
        lon: ids.map(() => 4),
        alt: ids.map(() => 1000),
        trk: ids.map(() => 90),
        actype: ids.map(() => 'A320'),
        inconf: ids.map(() => false),
    } as AircraftData;
}

describe('Aircraft3DCustomLayer.updateAircraft removal', () => {
    beforeEach(() => {
        fleetState.clear();
        removeCalls.length = 0;
    });

    it('removes a mesh when its aircraft disappears from a non-empty batch', () => {
        const layer = makeLayer();
        layer.updateAircraft(batch(['AC1', 'AC2']));
        expect(fleetState.has('AC1')).toBe(true);

        layer.updateAircraft(batch(['AC2']));

        expect(removeCalls).toContain('AC1');
        expect(fleetState.has('AC1')).toBe(false);
        expect(fleetState.has('AC2')).toBe(true);
    });

    it('clears the last aircraft when an empty batch arrives (no ghost)', () => {
        const layer = makeLayer();
        layer.updateAircraft(batch(['AC1']));
        expect(fleetState.has('AC1')).toBe(true);

        layer.updateAircraft(batch([]));

        expect(removeCalls).toContain('AC1');
        expect(fleetState.size).toBe(0);
    });

    it('ignores a batch with no id array without throwing', () => {
        const layer = makeLayer();
        layer.updateAircraft(batch(['AC1']));

        expect(() => layer.updateAircraft({} as AircraftData)).not.toThrow();
        // The existing aircraft is left untouched (guarded before removal).
        expect(fleetState.has('AC1')).toBe(true);
        expect(removeCalls).not.toContain('AC1');
    });
});
