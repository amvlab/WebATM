/**
 * Tests for AircraftRenderer: updateDisplayOptions change detection (side
 * effects must be gated on actual value changes, since MapOverlay always
 * passes the full DisplayOptions object) and trail sampling/highlighting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { AircraftData, DisplayOptions } from '../../../data/types';
import type { StateManager } from '../../../core/StateManager';
import { AircraftRenderer } from './AircraftRenderer';

class FakeContext {
    fillStyle = '';
    strokeStyle = '';
    lineWidth = 0;
    clearRect = vi.fn();
    beginPath = vi.fn();
    moveTo = vi.fn();
    lineTo = vi.fn();
    closePath = vi.fn();
    fill = vi.fn();
    stroke = vi.fn();
    getImageData = vi.fn((_x: number, _y: number, w: number, h: number) => ({ width: w, height: h }));
}

function fakeCanvas() {
    return {
        width: 0,
        height: 0,
        getContext: () => new FakeContext(),
    } as unknown as HTMLCanvasElement;
}

interface FakeSource {
    setData: ReturnType<typeof vi.fn>;
}

function fakeMap() {
    const images = new Map<string, object>();
    const pointsSource: FakeSource = { setData: vi.fn() };
    const trailsSource: FakeSource = { setData: vi.fn() };
    const layoutCalls: Array<[string, string, unknown]> = [];
    return {
        images,
        pointsSource,
        trailsSource,
        layoutCalls,
        hasImage: (name: string) => images.has(name),
        addImage: (name: string, image: object) => images.set(name, image),
        removeImage: (name: string) => images.delete(name),
        getSource: (id: string) =>
            id === 'aircraft-points' ? pointsSource
            : id === 'aircraft-trails' ? trailsSource
            : undefined,
        addSource: vi.fn(),
        getLayer: (id: string) => (id.startsWith('aircraft-') ? { id } : undefined),
        addLayer: vi.fn(),
        moveLayer: vi.fn(),
        setLayoutProperty: (layer: string, prop: string, value: unknown) =>
            layoutCalls.push([layer, prop, value]),
        setPaintProperty: vi.fn(),
    };
}

const BASE_OPTIONS = {
    showAircraft: true,
    showAircraftLabels: true,
    showAircraftId: true,
    showAircraftType: false,
    showAircraftSpeed: false,
    showAircraftAltitude: false,
    showAircraftTrails: false,
    showProtectedZones: false,
    speedType: 'tas',
    speedUnit: 'knots',
    altitudeUnit: 'ft',
    aircraftIconColor: '#00ff00',
    aircraftLabelColor: '#0066cc',
    aircraftSelectedColor: '#ff6600',
    aircraftConflictColor: '#ffa000',
    aircraftTrailColor: '#0066cc',
    trailConflictColor: '#ffa000',
    protectedZonesColor: '#00ff00',
    aircraftIconSize: 0.8,
    mapLabelsTextSize: 12,
} as DisplayOptions;

// One aircraft at FL100 doing ~200 kt TAS (all wire values in SI units)
const DATA = {
    id: ['KL204'],
    lat: [52.0],
    lon: [4.0],
    alt: [3048],
    tas: [102.9],
    vs: [0],
    trk: [90],
} as unknown as AircraftData;

const STATE_MANAGER = { getSimulationTime: () => 0 } as unknown as StateManager;

function makeRenderer(
    map: ReturnType<typeof fakeMap>,
    options: DisplayOptions,
    stateManager: StateManager = STATE_MANAGER
) {
    return new AircraftRenderer(map as unknown as MapLibreMap, options, () => undefined, stateManager);
}

/** Label text of the single feature in the last points setData call. */
function lastLabel(map: ReturnType<typeof fakeMap>): string {
    const calls = map.pointsSource.setData.mock.calls;
    const collection = calls[calls.length - 1][0] as GeoJSON.FeatureCollection;
    return collection.features[0].properties!.label_text as string;
}

beforeEach(() => {
    vi.stubGlobal('document', { createElement: fakeCanvas });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('AircraftRenderer.updateDisplayOptions', () => {
    it('rebuilds label text immediately when a label content option changes', () => {
        const map = fakeMap();
        const renderer = makeRenderer(map, { ...BASE_OPTIONS });
        renderer.updateAircraftDisplay(DATA);
        expect(lastLabel(map)).toBe('KL204');

        // Full options object, as MapOverlay always sends
        renderer.updateDisplayOptions({ ...BASE_OPTIONS, showAircraftSpeed: true });

        expect(lastLabel(map)).toBe('KL204\n200kt');
    });

    it('rebuilds label text immediately when a display unit changes', () => {
        const map = fakeMap();
        const renderer = makeRenderer(map, { ...BASE_OPTIONS, showAircraftAltitude: true });
        renderer.updateAircraftDisplay(DATA);
        expect(lastLabel(map)).toBe('KL204\n10000ft');

        renderer.updateDisplayOptions({ ...BASE_OPTIONS, showAircraftAltitude: true, altitudeUnit: 'fl' });

        expect(lastLabel(map)).toBe('KL204\nFL100');
    });

    it('does not rebuild features or sprites on an unrelated option change', () => {
        const map = fakeMap();
        const renderer = makeRenderer(map, { ...BASE_OPTIONS });
        renderer['createSprites']();
        renderer.updateAircraftDisplay(DATA);
        const setDataCalls = map.pointsSource.setData.mock.calls.length;
        const spriteBefore = map.images.get('aircraft-normal');
        expect(spriteBefore).toBeDefined();

        renderer.updateDisplayOptions({ ...BASE_OPTIONS, headerFontSize: 18 } as DisplayOptions);

        expect(map.pointsSource.setData.mock.calls.length).toBe(setDataCalls);
        expect(map.images.get('aircraft-normal')).toBe(spriteBefore);
    });

    it('regenerates sprites only when a color actually changes', () => {
        const map = fakeMap();
        const renderer = makeRenderer(map, { ...BASE_OPTIONS });
        renderer['createSprites']();
        renderer.updateAircraftDisplay(DATA);
        const spriteBefore = map.images.get('aircraft-normal');
        expect(spriteBefore).toBeDefined();

        renderer.updateDisplayOptions({ ...BASE_OPTIONS });
        expect(map.images.get('aircraft-normal')).toBe(spriteBefore);

        renderer.updateDisplayOptions({ ...BASE_OPTIONS, aircraftIconColor: '#ff0000' });
        expect(map.images.get('aircraft-normal')).not.toBe(spriteBefore);
    });

    it('does not rebuild features on a pure color change', () => {
        const map = fakeMap();
        const renderer = makeRenderer(map, { ...BASE_OPTIONS });
        renderer.updateAircraftDisplay(DATA);
        const setDataCalls = map.pointsSource.setData.mock.calls.length;

        // Colors live in sprites and paint expressions, not in the features
        renderer.updateDisplayOptions({ ...BASE_OPTIONS, aircraftLabelColor: '#123456' });

        expect(map.pointsSource.setData.mock.calls.length).toBe(setDataCalls);
    });

    it('applies icon and label sizes only when they change', () => {
        const map = fakeMap();
        const renderer = makeRenderer(map, { ...BASE_OPTIONS });

        renderer.updateDisplayOptions({ ...BASE_OPTIONS });
        expect(map.layoutCalls.filter(([, prop]) => prop === 'icon-size')).toHaveLength(0);
        expect(map.layoutCalls.filter(([, prop]) => prop === 'text-size')).toHaveLength(0);

        renderer.updateDisplayOptions({ ...BASE_OPTIONS, aircraftIconSize: 1.4, mapLabelsTextSize: 16 });
        expect(map.layoutCalls).toContainEqual(['aircraft-points', 'icon-size', 1.4]);
        expect(map.layoutCalls).toContainEqual(['aircraft-labels', 'text-size', 16]);
    });

    it('still applies visibility toggles on every update', () => {
        const map = fakeMap();
        const renderer = makeRenderer(map, { ...BASE_OPTIONS });

        renderer.updateDisplayOptions({ ...BASE_OPTIONS, showAircraft: false });

        expect(map.layoutCalls).toContainEqual(['aircraft-points', 'visibility', 'none']);
        expect(map.layoutCalls).toContainEqual(['aircraft-labels', 'visibility', 'none']);
    });
});

/** A single-aircraft ACDATA frame at the given sim time and longitude. */
function frame(simt: number | undefined, lon: number): AircraftData {
    return { ...DATA, simt, lon: [lon] } as AircraftData;
}

/** Feature collection of the last trails setData call. */
function lastTrails(map: ReturnType<typeof fakeMap>): GeoJSON.FeatureCollection {
    const calls = map.trailsSource.setData.mock.calls;
    return calls[calls.length - 1][0] as GeoJSON.FeatureCollection;
}

describe('AircraftRenderer trails', () => {
    it('samples with the frame simt and seeds the trail at the spawn position', () => {
        const map = fakeMap();
        const renderer = makeRenderer(map, { ...BASE_OPTIONS, showAircraftTrails: true });

        // STATE_MANAGER's SIMINFO clock stays at 0 throughout: only the
        // per-frame simt can drive the sampling here.
        renderer.updateAircraftDisplay(frame(0, 4.0));
        expect(lastTrails(map).features).toHaveLength(0); // one point is not a line yet

        renderer.updateAircraftDisplay(frame(5, 4.1));

        const trails = lastTrails(map).features;
        expect(trails).toHaveLength(1);
        expect((trails[0].geometry as GeoJSON.LineString).coordinates).toEqual([
            [4.0, 52.0],
            [4.1, 52.0],
        ]);
    });

    it('does not add a point before the save interval has elapsed', () => {
        const map = fakeMap();
        const renderer = makeRenderer(map, { ...BASE_OPTIONS, showAircraftTrails: true });

        renderer.updateAircraftDisplay(frame(0, 4.0));
        renderer.updateAircraftDisplay(frame(4.9, 4.05));

        expect(lastTrails(map).features).toHaveLength(0);
    });

    it('falls back to the SIMINFO clock when the frame has no simt', () => {
        const map = fakeMap();
        let simInfoTime = 0;
        const stateManager = { getSimulationTime: () => simInfoTime } as unknown as StateManager;
        const renderer = makeRenderer(map, { ...BASE_OPTIONS, showAircraftTrails: true }, stateManager);

        renderer.updateAircraftDisplay(frame(undefined, 4.0));
        simInfoTime = 5;
        renderer.updateAircraftDisplay(frame(undefined, 4.1));

        expect(lastTrails(map).features).toHaveLength(1);
    });

    it('refreshes the trail selected state on selection change without new data', () => {
        const map = fakeMap();
        const renderer = makeRenderer(map, { ...BASE_OPTIONS, showAircraftTrails: true });
        renderer.updateAircraftDisplay(frame(0, 4.0));
        renderer.updateAircraftDisplay(frame(5, 4.1));
        expect(lastTrails(map).features[0].properties!.selected).toBe(false);

        renderer.setSelectedAircraft('KL204');
        expect(lastTrails(map).features[0].properties!.selected).toBe(true);

        renderer.setSelectedAircraft(null);
        expect(lastTrails(map).features[0].properties!.selected).toBe(false);
    });

    it('restarts the trail when sim time goes backwards (reset / scenario rerun)', () => {
        const map = fakeMap();
        const renderer = makeRenderer(map, { ...BASE_OPTIONS, showAircraftTrails: true });

        // First run: build a two-point trail up to simt=120.
        renderer.updateAircraftDisplay(frame(115, 4.0));
        renderer.updateAircraftDisplay(frame(120, 4.1));
        expect(lastTrails(map).features).toHaveLength(1);

        // RESET;CRE respawns the same callsign with the clock back near 0.
        // The old trail must not stay attached to the new aircraft.
        renderer.updateAircraftDisplay(frame(0, 6.0));
        expect(lastTrails(map).features).toHaveLength(0);

        // And recording must resume on the new clock, not after 120+ sim s.
        renderer.updateAircraftDisplay(frame(5, 6.1));
        const trails = lastTrails(map).features;
        expect(trails).toHaveLength(1);
        expect((trails[0].geometry as GeoJSON.LineString).coordinates).toEqual([
            [6.0, 52.0],
            [6.1, 52.0],
        ]);
    });

    it('drops the trail when the aircraft disappears', () => {
        const map = fakeMap();
        const renderer = makeRenderer(map, { ...BASE_OPTIONS, showAircraftTrails: true });
        renderer.updateAircraftDisplay(frame(0, 4.0));
        renderer.updateAircraftDisplay(frame(5, 4.1));
        expect(lastTrails(map).features).toHaveLength(1);

        renderer.updateAircraftDisplay({ ...frame(10, 5.0), id: ['XX1'] } as AircraftData);

        expect(lastTrails(map).features).toHaveLength(0);
    });

    it('seeds the complete server-recorded history and keeps extending it', () => {
        const map = fakeMap();
        const renderer = makeRenderer(map, { ...BASE_OPTIONS, showAircraftTrails: true });
        renderer.updateAircraftDisplay(frame(100, 4.0)); // page opened mid-run

        renderer.seedTrails({ simt: 98, trails: { KL204: [[3.0, 52.0], [3.5, 52.0], [3.9, 52.0]] } });
        expect((lastTrails(map).features[0].geometry as GeoJSON.LineString).coordinates).toHaveLength(3);

        renderer.updateAircraftDisplay(frame(103, 4.1)); // 5 s after the server's last sample
        expect((lastTrails(map).features[0].geometry as GeoJSON.LineString).coordinates).toEqual([
            [3.0, 52.0], [3.5, 52.0], [3.9, 52.0], [4.1, 52.0],
        ]);
    });

    it('keeps a local trail that is longer than the server history', () => {
        const map = fakeMap();
        const renderer = makeRenderer(map, { ...BASE_OPTIONS, showAircraftTrails: true });
        renderer.updateAircraftDisplay(frame(0, 4.0));
        renderer.updateAircraftDisplay(frame(5, 4.1));
        renderer.updateAircraftDisplay(frame(10, 4.2));

        renderer.seedTrails({ simt: 10, trails: { KL204: [[4.0, 52.0], [4.2, 52.0]] } });

        expect((lastTrails(map).features[0].geometry as GeoJSON.LineString).coordinates).toHaveLength(3);
    });

    it('records while hidden without redrawing, then draws the full trail when shown', () => {
        const map = fakeMap();
        const renderer = makeRenderer(map, { ...BASE_OPTIONS, showAircraftTrails: false });
        renderer.updateAircraftDisplay(frame(0, 4.0));
        renderer.updateAircraftDisplay(frame(5, 4.1));
        renderer.updateAircraftDisplay(frame(10, 4.2));
        expect(map.trailsSource.setData).not.toHaveBeenCalled();

        renderer.updateDisplayOptions({ ...BASE_OPTIONS, showAircraftTrails: true });

        expect((lastTrails(map).features[0].geometry as GeoJSON.LineString).coordinates).toHaveLength(3);
    });

    it('thins a long trail instead of growing without bound, keeping both ends', () => {
        const map = fakeMap();
        const renderer = makeRenderer(map, { ...BASE_OPTIONS, showAircraftTrails: true });
        for (let step = 0; step <= 1200; step++) {
            renderer.updateAircraftDisplay(frame(step * 5, step * 0.01));
        }

        const coords = (lastTrails(map).features[0].geometry as GeoJSON.LineString).coordinates;
        expect(coords.length).toBeLessThanOrEqual(500);
        expect(coords[0]).toEqual([0, 52.0]);
        expect(coords[coords.length - 1]).toEqual([12, 52.0]);
    });
});
