/**
 * Tests for Aircraft3DRenderer layer lifecycle, focused on the style-wait
 * loop: a renderer destroyed (or re-initialized) while waiting for the map
 * style to load must NOT add its layer afterwards — a stale add would put a
 * zombie custom layer on the map that nothing references or removes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { DisplayOptions } from '../../../data/types';
import type { StateManager } from '../../../core/StateManager';
import { Aircraft3DRenderer } from './Aircraft3DRenderer';

vi.mock('./Aircraft3DCustomLayer', () => ({
    Aircraft3DCustomLayer: class {
        id = 'aircraft-3d-layer';
        cleanup = vi.fn();
        updateAircraft = vi.fn();
        updateDisplayOptions = vi.fn();
        updateModelPath = vi.fn();
        reloadAircraftModel = vi.fn();
        onOverridesChanged = vi.fn();
        onScaleOverridesChanged = vi.fn();
    },
}));

const DISPLAY_OPTIONS = { selectedAircraftModel: 'auto' } as DisplayOptions;

/** Minimal MapLibre map stub with a controllable style-loaded flag. */
function makeMap(styleLoaded: boolean) {
    const layers = new Set<string>();
    const map = {
        styleLoaded,
        isStyleLoaded: vi.fn(function (this: { styleLoaded: boolean }) {
            return this.styleLoaded;
        }),
        getLayer: vi.fn((id: string) => (layers.has(id) ? { id } : undefined)),
        addLayer: vi.fn((layer: { id: string }) => layers.add(layer.id)),
        removeLayer: vi.fn((id: string) => layers.delete(id)),
    };
    return { map: map as unknown as MapLibreMap, layers, raw: map };
}

/** Queue-based requestAnimationFrame so tests can advance frames manually. */
let rafQueue: FrameRequestCallback[];
function flushFrame(): void {
    const callbacks = rafQueue;
    rafQueue = [];
    callbacks.forEach((cb) => cb(0));
}

beforeEach(() => {
    rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length;
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('Aircraft3DRenderer layer lifecycle', () => {
    it('adds the layer immediately when the style is already loaded', () => {
        const { map, layers } = makeMap(true);
        const renderer = new Aircraft3DRenderer(DISPLAY_OPTIONS);

        renderer.initialize(map);

        expect(layers.has('aircraft-3d-layer')).toBe(true);
    });

    it('waits for the style to load before adding the layer', () => {
        const { map, layers, raw } = makeMap(false);
        const renderer = new Aircraft3DRenderer(DISPLAY_OPTIONS);

        renderer.initialize(map);
        expect(layers.size).toBe(0);

        flushFrame(); // still not loaded
        expect(layers.size).toBe(0);

        raw.styleLoaded = true;
        flushFrame();
        expect(layers.has('aircraft-3d-layer')).toBe(true);
    });

    it('does NOT add the layer when destroyed while waiting for the style', () => {
        const { map, layers, raw } = makeMap(false);
        const renderer = new Aircraft3DRenderer(DISPLAY_OPTIONS);

        renderer.initialize(map);
        renderer.destroy();

        raw.styleLoaded = true;
        flushFrame();

        expect(layers.size).toBe(0);
        expect(rafQueue.length).toBe(0); // poll loop stopped, no leaked frames
    });

    it('abandons a stale wait when re-initialized on another map', () => {
        const first = makeMap(false);
        const second = makeMap(true);
        const renderer = new Aircraft3DRenderer(DISPLAY_OPTIONS);

        renderer.initialize(first.map);
        renderer.initialize(second.map);

        first.raw.styleLoaded = true;
        flushFrame();

        expect(first.layers.size).toBe(0);
        expect(second.layers.has('aircraft-3d-layer')).toBe(true);
    });

    it('unsubscribes StateManager overrides on destroy', () => {
        const unsubscribe = vi.fn();
        const stateManager = {
            subscribe: vi.fn(() => unsubscribe),
        } as unknown as StateManager;
        const renderer = new Aircraft3DRenderer(DISPLAY_OPTIONS, stateManager);

        renderer.destroy();

        expect(unsubscribe).toHaveBeenCalledTimes(2);
    });
});
