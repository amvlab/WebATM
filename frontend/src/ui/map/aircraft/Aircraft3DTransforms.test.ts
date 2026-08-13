/**
 * Tests for Aircraft3DTransforms scene-origin management. The scene origin
 * is shared by every mesh transform and the mercator camera matrix, so an
 * invalid aircraft record (NaN or out-of-range lat/lon, which BlueSky can
 * deliver, e.g. after MOVE beyond lat 90) must never leak into it:
 * MercatorCoordinate.fromLngLat throws on invalid input, which crashes the
 * whole data tick and the per-frame render.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Aircraft3DTransforms } from './Aircraft3DTransforms';
import type { AircraftMeshData } from './Aircraft3DTransforms';
import type { AircraftData, DisplayOptions } from '../../../data/types';

function makeTransforms(): Aircraft3DTransforms {
    return new Aircraft3DTransforms({
        getMap: () => null,
        getCamera: () => new THREE.PerspectiveCamera(),
        getDisplayOptions: () => ({ aircraft3DScale: 2 } as unknown as DisplayOptions),
        createFallbackMatrix: () => new THREE.Matrix4(),
        stateManager: null,
    });
}

/** AircraftData carrying only the positions the origin logic reads. */
function acData(positions: Array<[number, number]>): AircraftData {
    return {
        id: positions.map((_, i) => `AC${i}`),
        lat: positions.map((p) => p[0]),
        lon: positions.map((p) => p[1]),
    } as unknown as AircraftData;
}

function meshData(lat: number, lon: number): AircraftMeshData {
    return { lat, lon, alt: 3000, hdg: 90, selected: false, inconf: false, actype: 'A320' };
}

describe('Aircraft3DTransforms scene origin vs invalid coordinates', () => {
    it('initializes the origin from the first valid aircraft, skipping invalid ones', () => {
        const t = makeTransforms();
        t.updateSceneOrigin(acData([[NaN, NaN], [52, 4]]));

        const mesh = new THREE.Object3D();
        t.updateMeshTransform(mesh, meshData(52, 4));

        // Origin is the valid aircraft, so its own offsets are ~zero.
        expect(mesh.position.x).toBeCloseTo(0);
        expect(mesh.position.z).toBeCloseTo(0);
    });

    it('returns false (no origin) when no valid aircraft and no map exist', () => {
        const t = makeTransforms();
        expect(t.updateSceneOrigin(acData([[91, 181]]))).toBe(false);
    });

    it('an aircraft moved beyond lat 90 does not drag the origin away from valid traffic', () => {
        const t = makeTransforms();
        t.updateSceneOrigin(acData([[52.2, 4.7]]));
        // BAD sits at lat 91 (as ACDATA reports after `MOVE BAD 91,181`)
        // next to an in-range aircraft.
        t.updateSceneOrigin(acData([[91, 181], [52.3, 4.62]]));

        const mesh = new THREE.Object3D();
        t.updateMeshTransform(mesh, meshData(52.3, 4.62));

        // The origin must stay near the valid traffic: offsets are small
        // and finite (a poisoned centroid would put it thousands of km away).
        expect(Number.isFinite(mesh.position.x)).toBe(true);
        expect(Math.abs(mesh.position.x)).toBeLessThan(50_000);
        expect(Math.abs(mesh.position.z)).toBeLessThan(50_000);
    });

    it('a NaN record does not poison the reposition centroid', () => {
        const t = makeTransforms();
        t.updateSceneOrigin(acData([[52.2, 4.7]]));
        // The valid aircraft is >10 km out, so the origin repositions; the
        // NaN record must be excluded from the centroid.
        t.updateSceneOrigin(acData([[NaN, 4], [53.5, 6]]));

        const mesh = new THREE.Object3D();
        t.updateMeshTransform(mesh, meshData(53.5, 6));

        expect(Number.isFinite(mesh.position.x)).toBe(true);
        expect(Math.abs(mesh.position.x)).toBeLessThan(50_000);
        expect(Math.abs(mesh.position.z)).toBeLessThan(50_000);
    });

    it('still repositions onto the centroid of valid traffic', () => {
        const t = makeTransforms();
        t.updateSceneOrigin(acData([[52, 4]]));
        expect(t.updateSceneOrigin(acData([[53.5, 6]]))).toBe(true);

        const mesh = new THREE.Object3D();
        t.updateMeshTransform(mesh, meshData(53.5, 6));
        expect(mesh.position.x).toBeCloseTo(0);
        expect(mesh.position.z).toBeCloseTo(0);
    });
});
