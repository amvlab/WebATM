/**
 * Characterization tests for AircraftRouteRenderer.buildRouteFeatures — the
 * pure feature-building half of the route renderer (no map required).
 *
 * The label-position cases guard the fix for near-vertical route segments:
 * a middle waypoint on a north-south route must get a side anchor
 * ('left'/'right'), not a top/bottom anchor that horizontally centers the
 * label across the route line.
 */
import { describe, it, expect } from 'vitest';
import type { Map } from 'maplibre-gl';
import { AircraftRouteRenderer } from './AircraftRouteRenderer';
import type { DisplayOptions, RouteData } from '../../../data/types';

const displayOptions = {
    altitudeUnit: 'ft',
    speedUnit: 'knots',
    routeLinesColor: '#ff00ff',
    routePointsColor: '#ffff00',
    routeLabelsColor: '#ffffff',
    mapLabelsTextSize: 12
} as DisplayOptions;

// buildRouteFeatures never touches the map, so no map stub is needed.
const renderer = new AircraftRouteRenderer(null as unknown as Map, displayOptions);

/** A 4-waypoint due-north route with the aircraft south of it. */
function northboundRoute(over: Partial<RouteData> = {}): RouteData {
    return {
        acid: 'KL1',
        iactwp: 1,
        aclat: 52.0,
        aclon: 4.0,
        wplat: [52.1, 52.2, 52.3, 52.4],
        wplon: [4.0, 4.0, 4.0, 4.0],
        wpalt: [0, 3048, 0, 0],          // meters; > 0 means constrained
        wpspd: [0, 128.611, 0, 0],       // CAS m/s; 128.611 ~= 250 kt
        wpname: ['WPA', 'WPB', 'WPC', 'WPD'],
        ...over
    };
}

function labelProps(f: GeoJSON.Feature): { name: string; anchor: string; offset: [number, number]; isPassed: boolean } {
    return f.properties as { name: string; anchor: string; offset: [number, number]; isPassed: boolean };
}

describe('buildRouteFeatures', () => {
    it('builds one feature set per source from a valid route', () => {
        const f = renderer.buildRouteFeatures(northboundRoute(), 1);

        expect(f.completeRouteFeatures).toHaveLength(3);   // N-1 segments
        expect(f.aircraftToActiveFeatures).toHaveLength(1);
        expect(f.remainingRouteFeatures).toHaveLength(1);
        expect(f.waypointFeatures).toHaveLength(4);
        expect(f.labelFeatures).toHaveLength(4);
    });

    it('flags waypoints before the active index as passed and the active one as active', () => {
        const f = renderer.buildRouteFeatures(northboundRoute(), 1);
        const props = f.waypointFeatures.map((w) => w.properties as { isActive: boolean; isPassed: boolean });

        expect(props.map((p) => p.isPassed)).toEqual([true, false, false, false]);
        expect(props.map((p) => p.isActive)).toEqual([false, true, false, false]);
    });

    it('omits the aircraft-to-active line when the aircraft position is invalid', () => {
        const f = renderer.buildRouteFeatures(northboundRoute({ aclat: Number.NaN }), 1);
        expect(f.aircraftToActiveFeatures).toHaveLength(0);
    });

    it('skips waypoints with invalid coordinates everywhere they are used', () => {
        const f = renderer.buildRouteFeatures(
            northboundRoute({ wplat: [52.1, 52.2, Number.NaN, 52.4] }), 1);

        expect(f.waypointFeatures).toHaveLength(3);
        expect(f.labelFeatures).toHaveLength(3);
        // Only the 0-1 segment has two valid endpoints
        expect(f.completeRouteFeatures).toHaveLength(1);
    });

    it('renders altitude and speed constraints on the label', () => {
        const f = renderer.buildRouteFeatures(northboundRoute(), 1);
        const label = labelProps(f.labelFeatures[1]);

        // 3048 m -> 10000 ft, 128.611 m/s -> 250 kt
        expect(label.name).toBe('WPB\n10000 ft 250 kt');
    });

    it('renders an altitude constraint even when speeds are absent', () => {
        const f = renderer.buildRouteFeatures(northboundRoute({ wpspd: [] }), 1);
        expect(labelProps(f.labelFeatures[1]).name).toBe('WPB\n10000 ft');
    });
});

describe('antimeridian crossings', () => {
    /** Route flying east across ±180 near Fiji, aircraft west of the line. */
    function crossingRoute(over: Partial<RouteData> = {}): RouteData {
        return northboundRoute({
            aclat: -17.7,
            aclon: 179.6,
            wplat: [-17.7, -17.7, -17.7, -17.7],
            wplon: [179.8, 179.95, -179.9, -179.7],
            ...over
        });
    }

    function lineLons(f: GeoJSON.Feature): number[] {
        return (f.geometry as GeoJSON.LineString).coordinates.map((c) => c[0]);
    }

    it('draws a complete-route segment across the antimeridian, not around the world', () => {
        const f = renderer.buildRouteFeatures(crossingRoute(), 1);
        // Segment 179.95 -> -179.9 must be unwrapped to 179.95 -> 180.1.
        expect(lineLons(f.completeRouteFeatures[1])).toEqual([179.95, expect.closeTo(180.1, 10)]);
        // Segments on one side of the line stay as-is.
        expect(lineLons(f.completeRouteFeatures[0])).toEqual([179.8, 179.95]);
    });

    it('unwraps a westward crossing below -180', () => {
        const f = renderer.buildRouteFeatures(crossingRoute({
            wplon: [-179.7, -179.9, 179.95, 179.8]
        }), 1);
        expect(lineLons(f.completeRouteFeatures[1])).toEqual([-179.9, expect.closeTo(-180.05, 10)]);
    });

    it('draws the aircraft-to-active line across the antimeridian', () => {
        const f = renderer.buildRouteFeatures(crossingRoute(), 2);
        // Aircraft at 179.6 to active waypoint at -179.9 -> unwrapped 180.1.
        expect(lineLons(f.aircraftToActiveFeatures[0])).toEqual([179.6, expect.closeTo(180.1, 10)]);
    });

    it('unwraps the remaining-route polyline cumulatively past the crossing', () => {
        const f = renderer.buildRouteFeatures(crossingRoute(), 1);
        // From the active waypoint onward: 179.95, -179.9, -179.7 unwrap to
        // a monotonically increasing eastbound track.
        expect(lineLons(f.remainingRouteFeatures[0])).toEqual([
            179.95, expect.closeTo(180.1, 10), expect.closeTo(180.3, 10)
        ]);
    });

    it('leaves waypoint circles and labels at their in-range coordinates', () => {
        const f = renderer.buildRouteFeatures(crossingRoute(), 1);
        const lons = f.waypointFeatures.map((w) => (w.geometry as GeoJSON.Point).coordinates[0]);
        expect(lons).toEqual([179.8, 179.95, -179.9, -179.7]);
    });
});

describe('label placement', () => {
    it('anchors first and last waypoint labels beside the point', () => {
        const f = renderer.buildRouteFeatures(northboundRoute(), 1);

        expect(labelProps(f.labelFeatures[0]).anchor).toBe('right');
        expect(labelProps(f.labelFeatures[0]).offset).toEqual([-0.8, 0]);
        expect(labelProps(f.labelFeatures[3]).anchor).toBe('left');
        expect(labelProps(f.labelFeatures[3]).offset).toEqual([0.8, 0]);
    });

    it('gives middle waypoints of a north-south route a side anchor clear of the line', () => {
        const f = renderer.buildRouteFeatures(northboundRoute(), 1);

        for (const i of [1, 2]) {
            const { anchor, offset } = labelProps(f.labelFeatures[i]);
            expect(anchor).toMatch(/^(left|right)$/);
            expect(Math.abs(offset[0])).toBeGreaterThan(1);
            expect(Math.abs(offset[1])).toBeLessThan(0.01);
        }
    });

    it('places middle waypoint labels of an east-west route above the line', () => {
        const f = renderer.buildRouteFeatures(northboundRoute({
            wplat: [52.0, 52.0, 52.0, 52.0],
            wplon: [4.0, 4.2, 4.4, 4.6]
        }), 1);

        for (const i of [1, 2]) {
            const { anchor, offset } = labelProps(f.labelFeatures[i]);
            expect(anchor).toBe('bottom');
            expect(Math.abs(offset[0])).toBeLessThan(0.01);
            expect(offset[1]).toBeLessThan(-1);   // em offset up (screen -Y)
        }
    });

    it('places a single-waypoint route label above the point', () => {
        const f = renderer.buildRouteFeatures(northboundRoute({
            wplat: [52.1], wplon: [4.0], wpname: ['ONLY'], wpalt: [0], wpspd: [0]
        }), 0);

        expect(labelProps(f.labelFeatures[0]).anchor).toBe('bottom');
        expect(labelProps(f.labelFeatures[0]).offset).toEqual([0, -0.8]);
    });
});
