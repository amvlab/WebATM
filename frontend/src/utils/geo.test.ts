/**
 * Tests for the shared aviation-bearing helpers used by the map drawing
 * modes (ConsoleMapPicker heading picks, aircraft map-draw creation).
 */
import { describe, it, expect } from 'vitest';
import { computeBearing, roundedBearing, normalizeLongitude } from './geo';

describe('normalizeLongitude', () => {
    it('leaves in-range longitudes untouched (including the ±180 edges)', () => {
        expect(normalizeLongitude(0)).toBe(0);
        expect(normalizeLongitude(179.99)).toBe(179.99);
        expect(normalizeLongitude(180)).toBe(180);
        expect(normalizeLongitude(-180)).toBe(-180);
    });

    it('wraps longitudes just past the antimeridian (BlueSky post-crossing values)', () => {
        expect(normalizeLongitude(180.067)).toBeCloseTo(-179.933, 10);
        expect(normalizeLongitude(-180.5)).toBeCloseTo(179.5, 10);
    });

    it('wraps multi-revolution longitudes', () => {
        expect(normalizeLongitude(540.5)).toBeCloseTo(-179.5, 10);
        expect(normalizeLongitude(-361)).toBeCloseTo(-1, 10);
    });

    it('wraps deltas toward the nearest direction (centroid unwrapping)', () => {
        // -179.9 is 0.2° east of 179.9, not 359.8° west
        expect(normalizeLongitude(-179.9 - 179.9)).toBeCloseTo(0.2, 10);
        expect(normalizeLongitude(200)).toBeCloseTo(-160, 10);
    });
});

describe('computeBearing', () => {
    it('returns 0 for due north', () => {
        expect(computeBearing(52, 4, 53, 4)).toBeCloseTo(0, 5);
    });

    it('returns 90 for due east on the equator', () => {
        expect(computeBearing(0, 0, 0, 1)).toBeCloseTo(90, 5);
    });

    it('returns 180 for due south', () => {
        expect(computeBearing(53, 4, 52, 4)).toBeCloseTo(180, 5);
    });

    it('returns 270 for due west on the equator', () => {
        expect(computeBearing(0, 1, 0, 0)).toBeCloseTo(270, 5);
    });

    it('stays within [0, 360)', () => {
        const brng = computeBearing(10, 20, -30, -40);
        expect(brng).toBeGreaterThanOrEqual(0);
        expect(brng).toBeLessThan(360);
    });
});

describe('roundedBearing', () => {
    it('rounds to a whole degree', () => {
        expect(roundedBearing(0, 0, 1, 1)).toBe(45);
    });

    it('normalizes a bearing that rounds up to 360 back to 0', () => {
        // Just west of due north: computeBearing ~359.7, which must read as
        // 0, never 360.
        expect(computeBearing(0, 0, 10, -0.05)).toBeGreaterThan(359);
        expect(roundedBearing(0, 0, 10, -0.05)).toBe(0);
    });
});
