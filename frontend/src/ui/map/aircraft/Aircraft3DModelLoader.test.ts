/**
 * Tests for Aircraft3DModelLoader cache disposal. The loader owns the cached
 * master models that aircraft meshes are cloned from, so clearing the cache
 * must dispose their geometry/materials (aircraft-mesh removal only detaches).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

// Capture the GLTFLoader onLoad callback so tests can drive a "loaded" model
// through the loader without touching the network.
const captured: { onLoad?: (gltf: { scene: THREE.Group }) => void } = {};
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
    GLTFLoader: class {
        load(_path: string, onLoad: (gltf: { scene: THREE.Group }) => void) {
            captured.onLoad = onLoad;
        }
    },
}));

import { Aircraft3DModelLoader } from './Aircraft3DModelLoader';

function multiMaterialModel(): {
    model: THREE.Group;
    geometry: THREE.BufferGeometry;
    materials: THREE.Material[];
} {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    const materials = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()];
    const model = new THREE.Group();
    model.add(new THREE.Mesh(geometry, materials));
    return { model, geometry, materials };
}

function makeLoader() {
    return new Aircraft3DModelLoader({
        getMaxAnisotropy: () => 1,
        onModelLoaded: vi.fn(),
    });
}

describe('Aircraft3DModelLoader cache disposal', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        captured.onLoad = undefined;
    });

    it('caches a loaded model and disposes its resources on clearCache()', () => {
        const loader = makeLoader();
        const { model, geometry, materials } = multiMaterialModel();
        const geomSpy = vi.spyOn(geometry, 'dispose');
        const matSpies = materials.map((m) => vi.spyOn(m, 'dispose'));

        loader.load('A320.glb');
        captured.onLoad?.({ scene: model });
        expect(loader.get('A320.glb')).toBe(model);

        loader.clearCache();

        expect(loader.get('A320.glb')).toBeUndefined();
        expect(geomSpy).toHaveBeenCalledTimes(1);
        matSpies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    });

    it('disposes cached model resources on clearAll()', () => {
        const loader = makeLoader();
        const { model, geometry, materials } = multiMaterialModel();
        const geomSpy = vi.spyOn(geometry, 'dispose');
        const matSpies = materials.map((m) => vi.spyOn(m, 'dispose'));

        loader.load('A320.glb');
        captured.onLoad?.({ scene: model });

        loader.clearAll();

        expect(loader.get('A320.glb')).toBeUndefined();
        expect(geomSpy).toHaveBeenCalledTimes(1);
        matSpies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    });
});
