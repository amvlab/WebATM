/**
 * Tests for Aircraft3DFleet mesh lifecycle, focused on resource disposal
 * (single- and multi-material meshes) and group detachment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { Aircraft3DFleet, type Aircraft3DFleetDeps } from './Aircraft3DFleet';
import type { AircraftMeshData } from './Aircraft3DTransforms';

const DATA: AircraftMeshData = {
    lat: 52, lon: 4, alt: 1000, hdg: 90, selected: false, inconf: false, actype: 'A320',
};

/** A model whose single mesh carries an array of materials. */
function multiMaterialModel(): {
    model: THREE.Group;
    geometry: THREE.BufferGeometry;
    materials: THREE.Material[];
} {
    const geometry = new THREE.BufferGeometry();
    const materials = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()];
    const mesh = new THREE.Mesh(geometry, materials);
    const model = new THREE.Group();
    model.add(mesh);
    return { model, geometry, materials };
}

function makeFleet(model: THREE.Group) {
    const mercatorGroup = new THREE.Group();
    const deps: Aircraft3DFleetDeps = {
        modelLoader: {
            get: () => model,
            load: vi.fn(),
            rawMaxDim: () => 10,
        } as unknown as Aircraft3DFleetDeps['modelLoader'],
        transforms: {
            updateMeshTransform: vi.fn(),
            updateMeshTransformForGlobe: vi.fn(),
        } as unknown as Aircraft3DFleetDeps['transforms'],
        getMercatorGroup: () => mercatorGroup,
        getGlobeGroup: () => null,
        isGlobeProjection: () => false,
    };
    return { fleet: new Aircraft3DFleet(deps), mercatorGroup };
}

describe('Aircraft3DFleet disposal', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('adds a created mesh to the mercator group', () => {
        const { model } = multiMaterialModel();
        const { fleet, mercatorGroup } = makeFleet(model);

        fleet.create('AC1', DATA, 'A320.glb');

        expect(fleet.size).toBe(1);
        expect(mercatorGroup.children.length).toBe(1);
    });

    it('disposes geometry and every material in a multi-material mesh on clear()', () => {
        const { model, geometry, materials } = multiMaterialModel();
        const geomSpy = vi.spyOn(geometry, 'dispose');
        const matSpies = materials.map((m) => vi.spyOn(m, 'dispose'));
        const { fleet, mercatorGroup } = makeFleet(model);

        fleet.create('AC1', DATA, 'A320.glb');
        fleet.clear();

        expect(geomSpy).toHaveBeenCalledTimes(1);
        // The bug: array materials were skipped, leaking the GPU resources.
        matSpies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
        expect(fleet.size).toBe(0);
        expect(mercatorGroup.children.length).toBe(0);
    });

    it('disposes resources and detaches the mesh on remove()', () => {
        const { model, geometry } = multiMaterialModel();
        const geomSpy = vi.spyOn(geometry, 'dispose');
        const { fleet, mercatorGroup } = makeFleet(model);

        fleet.create('AC1', DATA, 'A320.glb');
        fleet.remove('AC1');

        expect(geomSpy).toHaveBeenCalledTimes(1);
        expect(fleet.size).toBe(0);
        expect(mercatorGroup.children.length).toBe(0);
    });

    it('removeAllForReload clears live meshes without touching the pending queue', () => {
        const { model } = multiMaterialModel();
        const { fleet, mercatorGroup } = makeFleet(model);

        fleet.create('AC1', DATA, 'A320.glb');
        fleet.removeAllForReload();

        expect(fleet.size).toBe(0);
        expect(mercatorGroup.children.length).toBe(0);
    });
});
