/**
 * Tests for AircraftRenderer.updateDisplayOptions change detection.
 *
 * MapOverlay always passes the FULL DisplayOptions object, so every side
 * effect must be gated on an actual value change against the previous
 * options. The old `options.x !== undefined` checks were always true with a
 * full object: every option change (each input event of a slider drag
 * included) took the color path — regenerating all sprites, repainting the
 * label/zone/trail layers, and rebuilding every feature via updateColors'
 * unconditional refresh — while the intended non-color refresh branch was
 * dead code.
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
    const layoutCalls: Array<[string, string, unknown]> = [];
    return {
        images,
        pointsSource,
        layoutCalls,
        hasImage: (name: string) => images.has(name),
        addImage: (name: string, image: object) => images.set(name, image),
        removeImage: (name: string) => images.delete(name),
        getSource: (id: string) => (id === 'aircraft-points' ? pointsSource : undefined),
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

function makeRenderer(map: ReturnType<typeof fakeMap>, options: DisplayOptions) {
    return new AircraftRenderer(map as unknown as MapLibreMap, options, () => undefined, STATE_MANAGER);
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
