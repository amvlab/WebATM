/**
 * Tests for clampActiveWaypoint, the shared iactwp clamp used by both the
 * 2D (AircraftRoutes) and 3D (AircraftRoute3DRenderer) route renderers.
 * Semantics mirror BlueSky's own GUI (bluesky/ui/qtgl/gltraffic.py):
 * iactwp = min(max(0, iactwp), n - 1).
 */
import { describe, it, expect } from 'vitest';
import { clampActiveWaypoint } from './route';

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
