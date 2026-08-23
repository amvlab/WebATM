/**
 * Tests for AircraftRoute3DRenderer layer lifecycle, mirroring the
 * Aircraft3DRenderer suite: a renderer destroyed (or re-initialized on
 * another map) while waiting for the map style to load must NOT add its
 * layer afterwards. A stale add put a zombie 'route-3d-layer' on the map
 * that nothing referenced — it kept rendering the last-seeded route with
 * the 3D overlay off and forced a continuous repaint loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { DisplayOptions } from '../../../data/types';
import { AircraftRoute3DRenderer } from './AircraftRoute3DRenderer';

const DISPLAY_OPTIONS = { showRoutes: true } as DisplayOptions;

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

describe('AircraftRoute3DRenderer layer lifecycle', () => {
    it('adds the layer immediately when the style is already loaded', () => {
        const { map, layers } = makeMap(true);
        const renderer = new AircraftRoute3DRenderer(DISPLAY_OPTIONS);

        renderer.initialize(map);

        expect(layers.has('route-3d-layer')).toBe(true);
    });

    it('waits for the style to load before adding the layer', () => {
        const { map, layers, raw } = makeMap(false);
        const renderer = new AircraftRoute3DRenderer(DISPLAY_OPTIONS);

        renderer.initialize(map);
        expect(layers.size).toBe(0);

        flushFrame(); // still not loaded
        expect(layers.size).toBe(0);

        raw.styleLoaded = true;
        flushFrame();
        expect(layers.has('route-3d-layer')).toBe(true);
    });

    it('does NOT add the layer when destroyed while waiting for the style', () => {
        const { map, layers, raw } = makeMap(false);
        const renderer = new AircraftRoute3DRenderer(DISPLAY_OPTIONS);

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
        const renderer = new AircraftRoute3DRenderer(DISPLAY_OPTIONS);

        renderer.initialize(first.map);
        renderer.initialize(second.map);

        first.raw.styleLoaded = true;
        flushFrame();

        expect(first.layers.size).toBe(0);
        expect(second.layers.has('route-3d-layer')).toBe(true);
    });

    it('rebuilds the layer on a style change once the style loads', () => {
        const { map, layers, raw } = makeMap(true);
        const renderer = new AircraftRoute3DRenderer(DISPLAY_OPTIONS);
        renderer.initialize(map);
        expect(layers.has('route-3d-layer')).toBe(true);

        raw.styleLoaded = false;
        renderer.onStyleChange();
        flushFrame(); // deferred frame; style not loaded yet
        expect(rafQueue.length).toBe(1);

        raw.styleLoaded = true;
        flushFrame();
        expect(layers.has('route-3d-layer')).toBe(true);
    });

    it('does NOT rebuild on a style change when destroyed while waiting', () => {
        const { map, layers, raw } = makeMap(true);
        const renderer = new AircraftRoute3DRenderer(DISPLAY_OPTIONS);
        renderer.initialize(map);

        raw.styleLoaded = false;
        renderer.onStyleChange();
        renderer.destroy(); // removes the layer, aborts the pending wait

        raw.styleLoaded = true;
        flushFrame();
        flushFrame();

        expect(layers.size).toBe(0);
        expect(rafQueue.length).toBe(0);
    });
});
