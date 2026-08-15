/**
 * Tests for Aircraft3DModelLoader cache disposal. The loader owns the cached
 * master models that aircraft meshes are cloned from, so clearing the cache
 * must dispose their geometry/materials (aircraft-mesh removal only detaches).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

// Capture the GLTFLoader callbacks so tests can drive a load to success or
// failure without touching the network, and count the requests issued.
type MockGltf = { scene: THREE.Group; animations?: THREE.AnimationClip[] };
const captured: {
    onLoad?: (gltf: MockGltf) => void;
    onError?: (error: unknown) => void;
    loadCalls: string[];
} = { loadCalls: [] };
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
    GLTFLoader: class {
        load(
            path: string,
            onLoad: (gltf: MockGltf) => void,
            _onProgress?: unknown,
            onError?: (error: unknown) => void
        ) {
            captured.loadCalls.push(path);
            captured.onLoad = onLoad;
            captured.onError = onError;
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

    it('drops the recorded raw dimensions on clearCache()', () => {
        const loader = makeLoader();
        const { model } = multiMaterialModel();

        loader.load('A320.glb');
        captured.onLoad?.({ scene: model });
        expect(loader.rawMaxDim('A320.glb')).toBeGreaterThan(0);

        loader.clearCache();

        expect(loader.rawMaxDim('A320.glb')).toBeUndefined();
    });

    it('lets an in-flight load re-populate the cache after clearCache()', () => {
        const loader = makeLoader();
        const { model } = multiMaterialModel();

        loader.load('A320.glb');
        loader.clearCache(); // load still in flight

        captured.onLoad?.({ scene: model });

        expect(loader.get('A320.glb')).toBe(model);
    });

    it('discards a load that completes after clearAll()', () => {
        const onModelLoaded = vi.fn();
        const loader = new Aircraft3DModelLoader({
            getMaxAnisotropy: () => 1,
            onModelLoaded,
        });
        const { model, geometry, materials } = multiMaterialModel();
        const geomSpy = vi.spyOn(geometry, 'dispose');
        const matSpies = materials.map((m) => vi.spyOn(m, 'dispose'));

        loader.load('A320.glb');
        loader.clearAll(); // teardown while the load is in flight

        captured.onLoad?.({ scene: model });

        expect(loader.get('A320.glb')).toBeUndefined();
        expect(onModelLoaded).not.toHaveBeenCalled();
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

describe('Aircraft3DModelLoader animation clips', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        captured.onLoad = undefined;
    });

    it('keeps the GLB animation clips alongside the cached scene', () => {
        const loader = makeLoader();
        const { model } = multiMaterialModel();
        const clip = new THREE.AnimationClip('EngineSpin', 1, []);

        loader.load('prop.glb');
        captured.onLoad?.({ scene: model, animations: [clip] });

        expect(loader.animations('prop.glb')).toEqual([clip]);
    });

    it('returns an empty clip list for static models', () => {
        const loader = makeLoader();
        const { model } = multiMaterialModel();

        loader.load('A320.glb');
        captured.onLoad?.({ scene: model, animations: [] });

        expect(loader.animations('A320.glb')).toEqual([]);
    });

    it('drops stored clips when the cache is cleared', () => {
        const loader = makeLoader();
        const { model } = multiMaterialModel();
        const clip = new THREE.AnimationClip('EngineSpin', 1, []);

        loader.load('prop.glb');
        captured.onLoad?.({ scene: model, animations: [clip] });
        loader.clearCache();

        expect(loader.animations('prop.glb')).toEqual([]);
    });
});

describe('Aircraft3DModelLoader load failures', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        captured.onLoad = undefined;
        captured.onError = undefined;
        captured.loadCalls = [];
    });

    function makeFailureLoader() {
        const onModelFailed = vi.fn();
        const loader = new Aircraft3DModelLoader({
            getMaxAnisotropy: () => 1,
            onModelLoaded: vi.fn(),
            onModelFailed,
        });
        return { loader, onModelFailed };
    }

    it('records a failed load and notifies onModelFailed', () => {
        const { loader, onModelFailed } = makeFailureLoader();

        loader.load('missing.glb');
        captured.onError?.(new Error('404'));

        expect(loader.hasFailed('missing.glb')).toBe(true);
        expect(onModelFailed).toHaveBeenCalledWith('missing.glb');
    });

    it('does not re-request a path that already failed', () => {
        const { loader } = makeFailureLoader();

        loader.load('missing.glb');
        captured.onError?.(new Error('404'));
        loader.load('missing.glb');
        loader.load('missing.glb');

        expect(captured.loadCalls).toEqual(['missing.glb']);
    });

    it('clearCache() forgets failures so a reload retries the path', () => {
        const { loader } = makeFailureLoader();

        loader.load('missing.glb');
        captured.onError?.(new Error('404'));
        loader.clearCache();
        loader.load('missing.glb');

        expect(loader.hasFailed('missing.glb')).toBe(false);
        expect(captured.loadCalls).toEqual(['missing.glb', 'missing.glb']);
    });

    it('ignores a failure that arrives after clearAll()', () => {
        const { loader, onModelFailed } = makeFailureLoader();

        loader.load('missing.glb');
        loader.clearAll(); // teardown while the load is in flight

        captured.onError?.(new Error('404'));

        expect(loader.hasFailed('missing.glb')).toBe(false);
        expect(onModelFailed).not.toHaveBeenCalled();
    });
});
