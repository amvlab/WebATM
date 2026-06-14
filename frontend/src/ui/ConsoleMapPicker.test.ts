// @vitest-environment happy-dom
/**
 * Tests for ConsoleMapPicker's navaid snapping.
 *
 * Coordinate picks (lat/lon) land on the snapped navaid; heading picks (hdg,
 * gated to CRE) aim the bearing at the snapped navaid so the user can point a
 * new aircraft straight at a known airport/waypoint - mirroring the
 * Draw-Aircraft flow (AircraftCreationManager), which snaps both clicks.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConsoleMapPicker, GeoContext } from './ConsoleMapPicker';
import type { MapDisplay } from './map/MapDisplay';
import type { Console } from './Console';
import type { NavaidSnapper, SnapResult } from './map/navdata/NavaidSnapper';
import type { MapMouseEvent } from 'maplibre-gl';

/** Aviation bearing, kept in sync with ConsoleMapPicker.computeBearing. */
function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const phi1 = toRad(lat1);
    const phi2 = toRad(lat2);
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(phi2);
    const x =
        Math.cos(phi1) * Math.sin(phi2) -
        Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function createFakeMap() {
    const handlers: Record<string, Array<(e: unknown) => void>> = {};
    const sources: Record<string, { setData: ReturnType<typeof vi.fn> }> = {};
    const layers: Record<string, unknown> = {};
    return {
        getCanvas: () => ({ style: { cursor: '' } }),
        on: vi.fn((event: string, handler: (e: unknown) => void) => {
            (handlers[event] ??= []).push(handler);
        }),
        off: vi.fn((event: string, handler: (e: unknown) => void) => {
            handlers[event] = (handlers[event] ?? []).filter(h => h !== handler);
        }),
        fire(event: string, e: unknown) {
            (handlers[event] ?? []).forEach(h => h(e));
        },
        getSource: (id: string) => sources[id],
        addSource: (id: string) => {
            sources[id] = { setData: vi.fn() };
        },
        removeSource: (id: string) => {
            delete sources[id];
        },
        getLayer: (id: string) => layers[id],
        addLayer: (spec: { id: string }) => {
            layers[spec.id] = spec;
        },
        removeLayer: (id: string) => {
            delete layers[id];
        },
        getZoom: () => 8,
        project: ([lng, lat]: [number, number]) => ({ x: lng, y: lat }),
        queryRenderedFeatures: () => []
    };
}

function clickEvent(lat: number, lng: number): MapMouseEvent {
    return {
        lngLat: { lat, lng },
        point: { x: lng, y: lat },
        originalEvent: { preventDefault: vi.fn() }
    } as unknown as MapMouseEvent;
}

/** Shape of the GeoJSON handed to a guide-line source's setData(). */
interface LineFeatureCollection {
    features: Array<{ geometry: { coordinates: Array<[number, number]> } }>;
}

/** Last [start, end] coordinates pushed to the heading guide-line source. */
function lastGuideCoords(
    map: ReturnType<typeof createFakeMap>
): Array<[number, number]> | null {
    const src = map.getSource('console-picker-hdg-guide');
    if (!src) return null;
    const calls = src.setData.mock.calls;
    if (calls.length === 0) return null;
    const data = calls[calls.length - 1][0] as unknown as LineFeatureCollection;
    return data.features[0].geometry.coordinates;
}

const hdgContext: GeoContext = {
    kind: 'hdg',
    currentArgIndex: 4,
    // acid, type, lat, lon, hdg, alt, spd
    params: ['acid', 'type', 'lat', 'lon', 'hdg', 'alt', 'spd'],
    // parts[0] is the command token; arg i lives at parts[i + 1].
    parts: ['CRE', 'AC', 'B738', '52.000000', '4.000000', ''],
    command: 'CRE'
};

const latContext: GeoContext = {
    kind: 'lat',
    currentArgIndex: 2,
    params: ['acid', 'type', 'lat', 'lon', 'hdg', 'alt', 'spd'],
    parts: ['CRE', 'AC', 'B738', ''],
    command: 'CRE'
};

describe('ConsoleMapPicker navaid snapping', () => {
    let map: ReturnType<typeof createFakeMap>;
    let snapper: { snap: ReturnType<typeof vi.fn>; highlight: ReturnType<typeof vi.fn>; clearHighlight: ReturnType<typeof vi.fn> };
    let consoleInstance: { insertGeoValue: ReturnType<typeof vi.fn> };
    let picker: ConsoleMapPicker;

    beforeEach(() => {
        document.body.innerHTML = '<div class="console-input-container"></div>';
        map = createFakeMap();
        snapper = { snap: vi.fn(() => null), highlight: vi.fn(), clearHighlight: vi.fn() };
        consoleInstance = { insertGeoValue: vi.fn() };
        const mapDisplay = { getMap: () => map } as unknown as MapDisplay;
        picker = new ConsoleMapPicker(
            mapDisplay,
            consoleInstance as unknown as Console,
            snapper as unknown as NavaidSnapper
        );
    });

    it('aims a heading pick at the snapped navaid', () => {
        const snapResult: SnapResult = { lat: 53, lng: 5, ident: 'EHAM', kind: 'airport' };
        snapper.snap.mockReturnValue(snapResult);

        picker.enable(hdgContext);
        map.fire('click', clickEvent(10, 10)); // raw click far from the navaid

        const expected = Math.round(bearing(52, 4, 53, 5)).toString();
        expect(consoleInstance.insertGeoValue).toHaveBeenCalledWith(expected, 4, 1);
    });

    it('falls back to the raw cursor for headings when nothing snaps', () => {
        snapper.snap.mockReturnValue(null);

        picker.enable(hdgContext);
        map.fire('click', clickEvent(10, 10));

        const expected = Math.round(bearing(52, 4, 10, 10)).toString();
        expect(consoleInstance.insertGeoValue).toHaveBeenCalledWith(expected, 4, 1);
    });

    it('highlights snap candidates while a heading is being picked', () => {
        picker.enable(hdgContext);
        map.fire('mousemove', clickEvent(11, 11));
        expect(snapper.highlight).toHaveBeenCalled();
    });

    it('snaps the heading guide-line endpoint to the navaid on mousemove', () => {
        snapper.snap.mockReturnValue({ lat: 53, lng: 5, ident: 'EHAM', kind: 'airport' });

        picker.enable(hdgContext);
        map.fire('mousemove', clickEvent(10, 10)); // raw cursor far from the navaid

        // Guide runs origin (lon,lat) -> snapped navaid (lng,lat), not the cursor.
        expect(lastGuideCoords(map)).toEqual([
            [4, 52],
            [5, 53]
        ]);
    });

    it('draws the heading guide-line to the raw cursor when nothing snaps', () => {
        snapper.snap.mockReturnValue(null);

        picker.enable(hdgContext);
        map.fire('mousemove', clickEvent(10, 10));

        expect(lastGuideCoords(map)).toEqual([
            [4, 52],
            [10, 10]
        ]);
    });

    it('lands a coordinate pick on the snapped navaid', () => {
        const snapResult: SnapResult = { lat: 51.5, lng: 4.25, ident: 'EHRD', kind: 'airport' };
        snapper.snap.mockReturnValue(snapResult);

        picker.enable(latContext);
        map.fire('click', clickEvent(10, 10));

        expect(consoleInstance.insertGeoValue).toHaveBeenCalledWith(
            '51.500000,4.250000',
            2,
            2
        );
    });
});
