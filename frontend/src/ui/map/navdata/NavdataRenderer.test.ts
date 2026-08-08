/**
 * Tests for the basemap-aeroway style-swap pause in NavdataRenderer
 * (prepareForStyleChange / onStyleChange / the styleTransitioning latch).
 *
 * The pause exists to close a race: the persistent 'sourcedata' listener could
 * re-attach the basemap-aeroway layers to a source that MapLibre is mid-way
 * through removing during a style swap. These tests characterize the full
 * cycle — suppress while a swap is in flight, resume on style load, and
 * (crucially) resume on swap *failure* too, so a style URL that never loads
 * can't disable the overlay for the rest of the session.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { NavdataRenderer } from './NavdataRenderer';
import type { MapDisplay } from '../MapDisplay';
import type { StateManager } from '../../../core/StateManager';
import type { DisplayOptions } from '../../../data/types';

const BASEMAP_PAVEMENT = 'navdata-basemap-pavement-fill';
const BASEMAP_TAXIWAYS = 'navdata-basemap-taxiways-line';

type Handler = () => void;

/**
 * Minimal MapLibre map stand-in: tracks added/removed layers, exposes an
 * OpenMapTiles-style source (advertising an 'aeroway' vector layer) so
 * tryAddBasemapAeroway takes the basemap-attachment path, and dispatches
 * events to a snapshot of the listener list — the same semantics as
 * MapLibre's Evented, which the swap-error reset relies on.
 */
function makeMockMap() {
    const layers = new Set<string>();
    const handlers = new Map<string, Handler[]>();
    const sources: Record<string, { vectorLayerIds?: string[] }> = {
        navdata: {},
        openmaptiles: { vectorLayerIds: ['aeroway', 'transportation'] },
    };

    return {
        layers,
        on: vi.fn((type: string, handler: Handler) => {
            handlers.set(type, [...(handlers.get(type) ?? []), handler]);
        }),
        off: vi.fn((type: string, handler: Handler) => {
            const list = handlers.get(type) ?? [];
            const i = list.indexOf(handler);
            if (i >= 0) list.splice(i, 1);
        }),
        fire(type: string): void {
            for (const handler of [...(handlers.get(type) ?? [])]) handler();
        },
        listenerCount: (type: string) => (handlers.get(type) ?? []).length,
        addSource: vi.fn(),
        getSource: vi.fn((id: string) => sources[id]),
        addLayer: vi.fn((layer: { id: string }) => layers.add(layer.id)),
        removeLayer: vi.fn((id: string) => layers.delete(id)),
        getLayer: vi.fn((id: string) => (layers.has(id) ? { id } : undefined)),
        getStyle: vi.fn(() => ({ sources: { openmaptiles: {} } })),
        setLayoutProperty: vi.fn(),
        setPaintProperty: vi.fn(),
    };
}

function setup() {
    const map = makeMockMap();

    const displayOptions = {
        mapLabelsTextSize: 12,
        showAirports: true,
        showPavement: true,
        showRunways: true,
        showWaypoints: true,
        showWaypointIcons: true,
        showWaypointLabels: true,
        showAirportIcons: true,
        showAirportLabels: true,
        showHeliports: true,
        pavementColor: '#5a6470',
        runwayColor: '#c8d2dc',
    } as unknown as DisplayOptions;

    const stateManager = {
        getDisplayOptions: () => displayOptions,
        subscribe: vi.fn(),
    } as unknown as StateManager;

    const mapDisplay = {
        getMap: () => map as unknown as MapLibreMap,
        getMapTheme: () => 'dark' as const,
    } as unknown as MapDisplay;

    const renderer = new NavdataRenderer(mapDisplay, stateManager);
    return { renderer, map };
}

describe('NavdataRenderer basemap-aeroway style-swap pause', () => {
    it('suppresses sourcedata re-attachment while a swap is in flight, resumes on style load', () => {
        const { renderer, map } = setup();
        renderer.initialize();

        // Basemap metadata arrives: the aeroway layers attach.
        map.fire('sourcedata');
        expect(map.layers.has(BASEMAP_PAVEMENT)).toBe(true);
        expect(map.layers.has(BASEMAP_TAXIWAYS)).toBe(true);

        // Swap starts: layers torn down up-front, re-attachment paused.
        renderer.prepareForStyleChange();
        expect(map.layers.has(BASEMAP_PAVEMENT)).toBe(false);
        expect(map.layers.has(BASEMAP_TAXIWAYS)).toBe(false);
        map.fire('sourcedata');
        expect(map.layers.has(BASEMAP_PAVEMENT)).toBe(false);

        // New style loaded: pause lifted, self-attachment works again.
        renderer.onStyleChange();
        map.fire('sourcedata');
        expect(map.layers.has(BASEMAP_PAVEMENT)).toBe(true);
    });

    it('lifts the pause when the swap errors instead of loading', () => {
        const { renderer, map } = setup();
        renderer.initialize();
        renderer.prepareForStyleChange();
        map.fire('sourcedata');
        expect(map.layers.has(BASEMAP_PAVEMENT)).toBe(false);

        // The style document fetch fails (e.g. mistyped custom style URL):
        // 'style.load' will never fire, only 'error'. The overlay must not
        // stay disabled for the rest of the session.
        map.fire('error');
        map.fire('sourcedata');
        expect(map.layers.has(BASEMAP_PAVEMENT)).toBe(true);
    });

    it('detaches the swap-error listener once the swap completes', () => {
        const { renderer, map } = setup();
        renderer.initialize();
        const baseline = map.listenerCount('error');

        renderer.prepareForStyleChange();
        expect(map.listenerCount('error')).toBe(baseline + 1);

        renderer.onStyleChange();
        expect(map.listenerCount('error')).toBe(baseline);

        // Repeated swaps must not accumulate listeners either.
        renderer.prepareForStyleChange();
        renderer.prepareForStyleChange();
        expect(map.listenerCount('error')).toBe(baseline + 1);
    });

    it('does not let a stale error reset lift the pause of the fallback swap started by that same error', () => {
        const { renderer, map } = setup();
        renderer.initialize();

        // Stand-in for MapDisplay's persistent 'error' handler (always
        // registered before any swap): on failure it triggers the offline
        // fallback, which re-enters prepareForStyleChange synchronously.
        map.on('error', () => renderer.prepareForStyleChange());

        renderer.prepareForStyleChange(); // swap #1 begins
        map.fire('error'); // swap #1 fails -> fallback starts swap #2

        // Swap #2 is in flight; the stale reset from swap #1 (still delivered,
        // MapLibre dispatches to a snapshot) must not lift its pause.
        map.fire('sourcedata');
        expect(map.layers.has(BASEMAP_PAVEMENT)).toBe(false);

        // Fallback style loads: back to normal.
        renderer.onStyleChange();
        map.fire('sourcedata');
        expect(map.layers.has(BASEMAP_PAVEMENT)).toBe(true);
    });

    it('does not stay paused across destroy + re-initialize', () => {
        const { renderer, map } = setup();
        renderer.initialize();

        renderer.prepareForStyleChange(); // teardown happens mid-swap
        renderer.destroy();
        expect(map.listenerCount('error')).toBe(0);

        renderer.initialize();
        map.fire('sourcedata');
        expect(map.layers.has(BASEMAP_PAVEMENT)).toBe(true);
    });
});
