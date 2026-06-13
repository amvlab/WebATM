// @vitest-environment happy-dom
/**
 * Tests for the shared mercator math used by the 3D custom layers.
 * Runs under happy-dom because importing maplibre-gl needs a DOM-ish
 * global environment.
 */
import { describe, it, expect } from 'vitest';
import { relativePositionMeters, altitudeScaledForOrigin } from './mercatorUtils';

const AMS = { lng: 4.9, lat: 52.3 };

describe('relativePositionMeters', () => {
    it('returns zero offset for the origin itself', () => {
        const rel = relativePositionMeters(AMS, AMS);
        expect(rel.east).toBeCloseTo(0, 6);
        expect(rel.north).toBeCloseTo(0, 6);
    });

    it('points east are positive east, points north are positive north', () => {
        const east = relativePositionMeters(AMS, { lng: 5.0, lat: 52.3 });
        expect(east.east).toBeGreaterThan(0);
        expect(Math.abs(east.north)).toBeLessThan(Math.abs(east.east) / 100);

        const north = relativePositionMeters(AMS, { lng: 4.9, lat: 52.4 });
        expect(north.north).toBeGreaterThan(0);
        expect(Math.abs(north.east)).toBeLessThan(Math.abs(north.north) / 100);
    });

    it('roughly matches ground distance for small offsets', () => {
        // 0.1 deg of latitude is ~11.1 km of ground distance everywhere
        const rel = relativePositionMeters(AMS, { lng: 4.9, lat: 52.4 });
        expect(rel.north).toBeGreaterThan(10_000);
        expect(rel.north).toBeLessThan(12_500);
    });

    it('is antisymmetric when origin and target swap', () => {
        const target = { lng: 5.1, lat: 52.5 };
        const fwd = relativePositionMeters(AMS, target);
        const back = relativePositionMeters(target, AMS);
        // Not exactly equal (meter scale differs between the two origins),
        // but within 1% for nearby points.
        expect(Math.abs(back.east + fwd.east)).toBeLessThan(Math.abs(fwd.east) * 0.01);
        expect(Math.abs(back.north + fwd.north)).toBeLessThan(Math.abs(fwd.north) * 0.01);
    });
});

describe('altitudeScaledForOrigin', () => {
    it('returns the altitude unchanged when point and origin coincide', () => {
        expect(altitudeScaledForOrigin(1000, AMS, AMS)).toBeCloseTo(1000, 6);
    });

    it('scales by the ratio of mercator meter units (higher lat => larger scale)', () => {
        const northPoint = { lng: 4.9, lat: 60 };
        const scaled = altitudeScaledForOrigin(1000, northPoint, AMS);
        // cos(52.3)/cos(60) > 1, so the pre-scaled altitude must grow
        expect(scaled).toBeGreaterThan(1000);
        expect(scaled).toBeCloseTo(1000 * Math.cos((52.3 * Math.PI) / 180) / Math.cos((60 * Math.PI) / 180), 0);
    });
});
