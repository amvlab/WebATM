/**
 * Tests for CustomLayer3D.render()'s default camera projection.
 *
 * The default (MapLibre's mainMatrix) must track the map on EVERY frame a
 * subclass doesn't set its own projection. The old identity-check version
 * applied it only while the camera matrix was still identity — i.e. exactly
 * once — freezing the camera on the first frame's matrix afterwards (and
 * allocating two Matrix4 per frame to detect that one case).
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { CustomRenderMethodInput } from 'maplibre-gl';
import { CustomLayer3D } from './CustomLayer3D';
import type { Render3DArgs } from './CustomLayer3D';

/** Subclass whose updateScene optionally overrides the camera projection. */
class TestLayer extends CustomLayer3D {
    overrideMatrix: THREE.Matrix4 | null = null;

    constructor() {
        super('test-3d-layer');
    }

    protected onSceneReady(): void {}

    protected updateScene(_args?: Render3DArgs): void {
        if (this.overrideMatrix) {
            this.camera.projectionMatrix = this.overrideMatrix;
        }
    }
}

/**
 * Wire the protected fields render() touches without going through onAdd
 * (which would construct a real WebGLRenderer against a GL context).
 */
function makeLayer(): TestLayer {
    const layer = new TestLayer();
    Object.assign(layer as unknown as Record<string, unknown>, {
        camera: new THREE.Camera(),
        scene: new THREE.Scene(),
        map: {
            getCanvas: () => ({ width: 800, height: 600 }),
            triggerRepaint: vi.fn(),
        } as unknown as MapLibreMap,
        renderer: {
            getPixelRatio: () => 1,
            setPixelRatio: vi.fn(),
            setViewport: vi.fn(),
            resetState: vi.fn(),
            render: vi.fn(),
        },
    });
    return layer;
}

const fakeGl = {
    clear: vi.fn(),
    DEPTH_BUFFER_BIT: 0x00000100,
} as unknown as WebGLRenderingContext;

/** A translation matrix as the 16-element column-major array MapLibre passes. */
function matrixArray(tx: number): number[] {
    return new THREE.Matrix4().makeTranslation(tx, 0, 0).toArray();
}

function argsFor(matrix: number[]): CustomRenderMethodInput {
    return { defaultProjectionData: { mainMatrix: matrix } } as unknown as CustomRenderMethodInput;
}

function cameraOf(layer: TestLayer): THREE.Camera {
    return (layer as unknown as { camera: THREE.Camera }).camera;
}

describe('CustomLayer3D default camera projection', () => {
    it('applies the frame matrix when the subclass sets no projection', () => {
        const layer = makeLayer();
        layer.render(fakeGl, argsFor(matrixArray(5)));

        expect(cameraOf(layer).projectionMatrix.toArray()).toEqual(matrixArray(5));
    });

    it('tracks a changing map matrix across frames (no frozen default)', () => {
        const layer = makeLayer();
        layer.render(fakeGl, argsFor(matrixArray(5)));
        layer.render(fakeGl, argsFor(matrixArray(9)));

        expect(cameraOf(layer).projectionMatrix.toArray()).toEqual(matrixArray(9));
    });

    it('lets a subclass projection set in updateScene win over the default', () => {
        const layer = makeLayer();
        const custom = new THREE.Matrix4().makeTranslation(0, 42, 0);
        layer.overrideMatrix = custom;

        layer.render(fakeGl, argsFor(matrixArray(5)));

        expect(cameraOf(layer).projectionMatrix).toBe(custom);
        expect(cameraOf(layer).projectionMatrix.toArray()).toEqual(custom.toArray());
    });

    it('supports the legacy matrix-array render signature', () => {
        const layer = makeLayer();
        layer.render(fakeGl, matrixArray(7));

        expect(cameraOf(layer).projectionMatrix.toArray()).toEqual(matrixArray(7));
    });
});
