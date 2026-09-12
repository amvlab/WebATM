/**
 * Tests for AircraftRoute3DRenderer layer lifecycle, mirroring the
 * Aircraft3DRenderer suite: a renderer destroyed (or re-initialized on
 * another map) while waiting for the map style to load must NOT add its
 * layer afterwards. A stale add put a zombie 'route-3d-layer' on the map
 * that nothing referenced — it kept rendering the last-seeded route with
 * the 3D overlay off and forced a continuous repaint loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { DisplayOptions, RouteData } from '../../../data/types';
import { AircraftRoute3DRenderer, AircraftRoute3DCustomLayer } from './AircraftRoute3DRenderer';

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

/**
 * The route scene is rebuilt on every aircraft data tick (the scene origin
 * follows the aircraft). Waypoint sphere geometry and all materials must be
 * shared across rebuilds instead of disposed and reallocated per tick.
 */
describe('AircraftRoute3DCustomLayer geometry/material reuse', () => {
    const OPTIONS = {
        showRoutes: true,
        showRouteLines: true,
        showRoutePoints: true,
        aircraft3DScale: 2,
    } as DisplayOptions;

    const ROUTE = {
        acid: 'AC1',
        iactwp: 1,
        wplat: [52.0, 52.1, 52.2],
        wplon: [4.0, 4.1, 4.2],
        wpalt: [-999, 3000, -999],
        wpspd: [-999, -999, -999],
        wpname: ['WP1', 'WP2', 'WP3'],
    } as RouteData;

    /** Layer with the scene wired up directly, bypassing onAdd (needs real GL). */
    function makeLayer(): { layer: AircraftRoute3DCustomLayer; group: THREE.Group } {
        const layer = new AircraftRoute3DCustomLayer(OPTIONS);
        const group = new THREE.Group();
        Object.assign(layer as unknown as Record<string, unknown>, {
            scene: new THREE.Scene(),
            mercatorGroup: group,
            map: { triggerRepaint: vi.fn() },
        });
        layer.setSelectedAircraft('AC1');
        layer.setRouteData(ROUTE);
        layer.setAircraftState(52.0, 4.0, 2500);
        return { layer, group };
    }

    function spheres(group: THREE.Group): THREE.Mesh[] {
        return group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    }

    function lines(group: THREE.Group): THREE.Line[] {
        return group.children.filter(
            (c): c is THREE.Line => c instanceof THREE.Line && !(c instanceof THREE.Mesh)
        );
    }

    it('builds a sphere per waypoint and a line per segment', () => {
        const { group } = makeLayer();
        expect(spheres(group)).toHaveLength(3);
        // Aircraft->active + 1 passed + 1 upcoming segment
        expect(lines(group)).toHaveLength(3);
    });

    it('shares one sphere geometry across all waypoints and across rebuilds', () => {
        const { layer, group } = makeLayer();
        const firstGeometry = spheres(group)[0].geometry;
        expect(spheres(group).every((s) => s.geometry === firstGeometry)).toBe(true);

        // Next aircraft tick: full rebuild with a moved origin
        layer.setAircraftState(52.05, 4.05, 2600);

        expect(spheres(group)).toHaveLength(3);
        expect(spheres(group).every((s) => s.geometry === firstGeometry)).toBe(true);
    });

    it('reuses sphere and line materials across rebuilds', () => {
        const { layer, group } = makeLayer();
        const sphereMaterials = new Set(spheres(group).map((s) => s.material));
        const lineMaterials = new Set(lines(group).map((l) => l.material));

        layer.setAircraftState(52.05, 4.05, 2600);

        spheres(group).forEach((s) => expect(sphereMaterials.has(s.material)).toBe(true));
        lines(group).forEach((l) => expect(lineMaterials.has(l.material)).toBe(true));
    });

    it('sizes the active waypoint sphere 1.5x via mesh scale', () => {
        const { group } = makeLayer();
        const scales = spheres(group).map((s) => s.scale.x);
        const base = 60 * 2; // baseRadius * aircraft3DScale
        expect(scales).toEqual([base, base * 1.5, base]);
    });

    it('disposes the shared geometry and cached materials only on cleanup', () => {
        const { layer, group } = makeLayer();
        const geometry = spheres(group)[0].geometry;
        const material = spheres(group)[0].material as THREE.Material;
        const geometryDispose = vi.spyOn(geometry, 'dispose');
        const materialDispose = vi.spyOn(material, 'dispose');

        layer.setAircraftState(52.05, 4.05, 2600);
        expect(geometryDispose).not.toHaveBeenCalled();
        expect(materialDispose).not.toHaveBeenCalled();

        layer.cleanup();
        expect(geometryDispose).toHaveBeenCalledTimes(1);
        expect(materialDispose).toHaveBeenCalledTimes(1);
        expect(group.children).toHaveLength(0);
    });
});
