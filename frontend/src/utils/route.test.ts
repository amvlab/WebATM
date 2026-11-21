/**
 * Tests for the shared route helpers used by the route renderers and the
 * ROUTEDATA handler in App.ts.
 *
 * clampActiveWaypoint mirrors BlueSky's own GUI
 * (bluesky/ui/qtgl/gltraffic.py): iactwp = min(max(0, iactwp), n - 1).
 *
 * hasRouteWaypoints distinguishes real route updates from BlueSky's
 * waypoint-less route-clear broadcasts (route toggled off, or the displayed
 * aircraft was deleted — screenio._sendrte then streams {acid}-only frames
 * once per second). Clear frames must never become an implicit selection;
 * treating them as one re-selected a deleted aircraft in an endless loop.
 */
import { describe, it, expect } from 'vitest';
import { clampActiveWaypoint, hasRouteWaypoints, normalizeRouteLongitudes } from './route';
import type { RouteData } from '../data/types';

describe('clampActiveWaypoint', () => {
    it('passes a valid in-range index through', () => {
        expect(clampActiveWaypoint(2, 5)).toBe(2);
        expect(clampActiveWaypoint(0, 1)).toBe(0);
    });

    it('treats BlueSky\'s -1 "no active waypoint" sentinel as the first waypoint', () => {
        expect(clampActiveWaypoint(-1, 3)).toBe(0);
    });

    it('clamps a stale out-of-range index to the last waypoint', () => {
        expect(clampActiveWaypoint(7, 3)).toBe(2);
    });

    it('falls back to the first waypoint when iactwp is missing', () => {
        expect(clampActiveWaypoint(undefined, 3)).toBe(0);
        expect(clampActiveWaypoint(NaN, 3)).toBe(0);
    });
});

describe('normalizeRouteLongitudes', () => {
    function route(over: Partial<RouteData> = {}): RouteData {
        return {
            acid: 'KL1',
            iactwp: 0,
            aclat: -17.7,
            aclon: 179.9,
            wplat: [-17.8, -17.9],
            wplon: [179.95, -179.9],
            wpalt: [0, 0],
            wpspd: [0, 0],
            wpname: ['WPA', 'WPB'],
            ...over
        };
    }

    it('returns the same object when all longitudes are already in range', () => {
        const data = route();
        expect(normalizeRouteLongitudes(data)).toBe(data);
    });

    it('wraps an out-of-range aircraft longitude (post-antimeridian-crossing ACDATA style)', () => {
        const data = normalizeRouteLongitudes(route({ aclon: 180.3 }));
        expect(data.aclon).toBeCloseTo(-179.7, 10);
    });

    it('wraps out-of-range waypoint longitudes without touching in-range ones', () => {
        const data = normalizeRouteLongitudes(route({ wplon: [179.95, 180.4] }));
        expect(data.wplon[0]).toBe(179.95);
        expect(data.wplon[1]).toBeCloseTo(-179.6, 10);
    });

    it('does not mutate the input frame', () => {
        const original = route({ aclon: 180.3 });
        normalizeRouteLongitudes(original);
        expect(original.aclon).toBe(180.3);
    });
});

describe('hasRouteWaypoints', () => {
    it('is true for a route update that carries waypoints', () => {
        expect(hasRouteWaypoints({ wplat: [52.0, 52.6] })).toBe(true);
    });

    it('is false for a deleted-aircraft clear frame ({acid} only, no wplat)', () => {
        expect(hasRouteWaypoints({})).toBe(false);
    });

    it('is false for an empty waypoint list', () => {
        expect(hasRouteWaypoints({ wplat: [] })).toBe(false);
    });

    it('is false for missing or malformed data', () => {
        expect(hasRouteWaypoints(null)).toBe(false);
        expect(hasRouteWaypoints(undefined)).toBe(false);
        expect(hasRouteWaypoints({ wplat: 'not-an-array' as unknown as number[] })).toBe(false);
    });
});
