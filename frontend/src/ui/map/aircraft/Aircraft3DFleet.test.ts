/**
 * Tests for Aircraft3DFleet mesh lifecycle, focused on group detachment and
 * the shared-resource contract: aircraft meshes are clones of the cached
 * model, so the fleet only detaches them — the model loader owns disposal of
 * the shared geometry/materials.
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

function makeFleet(model: THREE.Group, animations: THREE.AnimationClip[] = []) {
    const mercatorGroup = new THREE.Group();
    const deps: Aircraft3DFleetDeps = {
        modelLoader: {
            get: () => model,
            load: vi.fn(),
            rawMaxDim: () => 10,
            animations: () => animations,
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

describe('Aircraft3DFleet lifecycle', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('adds a created mesh to the mercator group', () => {
        const { model } = multiMaterialModel();
        const { fleet, mercatorGroup } = makeFleet(model);

        fleet.create('AC1', DATA, 'A320.glb');

        expect(fleet.size).toBe(1);
        expect(mercatorGroup.children.length).toBe(1);
    });

    it('detaches the mesh from its group on remove()', () => {
        const { model } = multiMaterialModel();
        const { fleet, mercatorGroup } = makeFleet(model);

        fleet.create('AC1', DATA, 'A320.glb');
        fleet.remove('AC1');

        expect(fleet.size).toBe(0);
        expect(mercatorGroup.children.length).toBe(0);
    });

    it('does NOT dispose shared model resources when one aircraft is removed', () => {
        // Two aircraft cloned from the same cached model share its geometry
        // and materials. Removing one must not dispose resources the other
        // still uses — the loader owns disposal of the cached model.
        const { model, geometry, materials } = multiMaterialModel();
        const geomSpy = vi.spyOn(geometry, 'dispose');
        const matSpies = materials.map((m) => vi.spyOn(m, 'dispose'));
        const { fleet, mercatorGroup } = makeFleet(model);

        fleet.create('AC1', DATA, 'A320.glb');
        fleet.create('AC2', DATA, 'A320.glb');
        fleet.remove('AC1');

        expect(geomSpy).not.toHaveBeenCalled();
        matSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
        expect(fleet.size).toBe(1);
        expect(mercatorGroup.children.length).toBe(1);
    });

    it('clear() detaches all meshes without disposing shared resources', () => {
        const { model, geometry, materials } = multiMaterialModel();
        const geomSpy = vi.spyOn(geometry, 'dispose');
        const matSpies = materials.map((m) => vi.spyOn(m, 'dispose'));
        const { fleet, mercatorGroup } = makeFleet(model);

        fleet.create('AC1', DATA, 'A320.glb');
        fleet.clear();

        expect(geomSpy).not.toHaveBeenCalled();
        matSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
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

describe('Aircraft3DFleet pending-model fallback', () => {
    beforeEach(() => vi.restoreAllMocks());

    /** Fleet whose model loader only has models for the given paths. */
    function makeFleetWithModels(models: Record<string, THREE.Group>) {
        const mercatorGroup = new THREE.Group();
        const load = vi.fn();
        const deps: Aircraft3DFleetDeps = {
            modelLoader: {
                get: (path: string) => models[path],
                load,
                rawMaxDim: () => 10,
                animations: () => [],
            } as unknown as Aircraft3DFleetDeps['modelLoader'],
            transforms: {
                updateMeshTransform: vi.fn(),
                updateMeshTransformForGlobe: vi.fn(),
            } as unknown as Aircraft3DFleetDeps['transforms'],
            getMercatorGroup: () => mercatorGroup,
            getGlobeGroup: () => null,
            isGlobeProjection: () => false,
        };
        return { fleet: new Aircraft3DFleet(deps), mercatorGroup, load };
    }

    it('redirectPending creates queued aircraft with the fallback model', () => {
        const { model } = multiMaterialModel();
        const { fleet, mercatorGroup } = makeFleetWithModels({ 'A320.glb': model });

        fleet.create('AC1', DATA, 'missing.glb'); // queued, model not available
        expect(fleet.size).toBe(0);

        fleet.redirectPending('missing.glb', 'A320.glb');

        expect(fleet.size).toBe(1);
        expect(fleet.get('AC1')?.modelPath).toBe('A320.glb');
        expect(mercatorGroup.children.length).toBe(1);
    });

    it('redirectPending re-queues when the fallback model is not loaded yet', () => {
        const models: Record<string, THREE.Group> = {};
        const { fleet, load } = makeFleetWithModels(models);

        fleet.create('AC1', DATA, 'missing.glb');
        fleet.redirectPending('missing.glb', 'fallback.glb');

        expect(fleet.size).toBe(0);
        expect(load).toHaveBeenCalledWith('fallback.glb');

        // The fallback finishes loading -> the aircraft is created with it.
        models['fallback.glb'] = multiMaterialModel().model;
        fleet.processPending('fallback.glb');

        expect(fleet.get('AC1')?.modelPath).toBe('fallback.glb');
    });

    it('redirectPending without a fallback drops the queued aircraft', () => {
        const { model } = multiMaterialModel();
        const { fleet, mercatorGroup } = makeFleetWithModels({ 'A320.glb': model });

        fleet.create('AC1', DATA, 'missing.glb');
        fleet.redirectPending('missing.glb', null);

        expect(fleet.size).toBe(0);
        expect(mercatorGroup.children.length).toBe(0);
    });

    it('redirectPending leaves aircraft queued for other models alone', () => {
        const models: Record<string, THREE.Group> = {};
        const { fleet } = makeFleetWithModels(models);

        fleet.create('AC1', DATA, 'missing.glb');
        fleet.create('AC2', DATA, 'other.glb');
        fleet.redirectPending('missing.glb', null);

        // AC2 is still queued: when its model arrives it is created.
        models['other.glb'] = multiMaterialModel().model;
        fleet.processPending('other.glb');

        expect(fleet.get('AC1')).toBeUndefined();
        expect(fleet.get('AC2')?.modelPath).toBe('other.glb');
    });
});

describe('Aircraft3DFleet GLB animation playback', () => {
    beforeEach(() => vi.restoreAllMocks());

    /** A model with a named child node and a clip that spins it around Y. */
    function animatedModel(): { model: THREE.Group; clip: THREE.AnimationClip } {
        const { model } = multiMaterialModel();
        const engine = new THREE.Object3D();
        engine.name = 'Engine';
        model.add(engine);
        const track = new THREE.QuaternionKeyframeTrack(
            'Engine.quaternion',
            [0, 1],
            [
                ...new THREE.Quaternion().toArray(),
                ...new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2).toArray(),
            ],
        );
        return { model, clip: new THREE.AnimationClip('EngineSpin', 1, [track]) };
    }

    it('creates no mixer for static models', () => {
        const { model } = multiMaterialModel();
        const { fleet } = makeFleet(model);

        fleet.create('AC1', DATA, 'A320.glb');

        expect(fleet.get('AC1')?.mixer).toBeUndefined();
    });

    it('plays the GLB clips on the aircraft clone when advanced', () => {
        const { model, clip } = animatedModel();
        const { fleet, mercatorGroup } = makeFleet(model, [clip]);

        fleet.create('AC1', DATA, 'A320.glb');
        const entry = fleet.get('AC1');
        expect(entry?.mixer).toBeDefined();

        fleet.advanceAnimations(0.5);

        // The clone's Engine node rotated; the cached master stayed put.
        const cloned = mercatorGroup.children[0].getObjectByName('Engine');
        const master = model.getObjectByName('Engine');
        expect(cloned?.quaternion.equals(new THREE.Quaternion())).toBe(false);
        expect(master?.quaternion.equals(new THREE.Quaternion())).toBe(true);
    });

    it('each aircraft animates independently on its own mixer', () => {
        const { model, clip } = animatedModel();
        const { fleet } = makeFleet(model, [clip]);

        fleet.create('AC1', DATA, 'A320.glb');
        fleet.create('AC2', DATA, 'A320.glb');

        expect(fleet.get('AC1')?.mixer).toBeDefined();
        expect(fleet.get('AC2')?.mixer).toBeDefined();
        expect(fleet.get('AC1')?.mixer).not.toBe(fleet.get('AC2')?.mixer);
    });

    it('stops and unbinds the mixer when the aircraft is removed', () => {
        const { model, clip } = animatedModel();
        const { fleet } = makeFleet(model, [clip]);

        fleet.create('AC1', DATA, 'A320.glb');
        const mixer = fleet.get('AC1')?.mixer;
        expect(mixer).toBeDefined();
        const stopSpy = vi.spyOn(mixer as THREE.AnimationMixer, 'stopAllAction');

        fleet.remove('AC1');

        expect(stopSpy).toHaveBeenCalledTimes(1);
        // Advancing after removal must not touch the removed mixer.
        expect(() => fleet.advanceAnimations(0.5)).not.toThrow();
    });
});
