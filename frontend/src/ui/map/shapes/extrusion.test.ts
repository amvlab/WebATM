/**
 * Tests for the 3D extrusion bounds of polygon shapes.
 */
import { describe, it, expect } from 'vitest';
import { extrusionBounds } from './extrusion';

describe('extrusionBounds', () => {
    it('returns the vertical extent of an altitude-bounded polygon', () => {
        expect(extrusionBounds({ topAltitude: 2438.4, bottomAltitude: 609.6 }))
            .toEqual({ top: 2438.4, base: 609.6 });
    });

    it('defaults a missing bottom altitude to ground level', () => {
        expect(extrusionBounds({ topAltitude: 1500 })).toEqual({ top: 1500, base: 0 });
    });

    it('returns null for a polygon without altitude data, so it renders flat', () => {
        expect(extrusionBounds({})).toBeNull();
        expect(extrusionBounds({ topAltitude: undefined, bottomAltitude: undefined })).toBeNull();
    });

    it('returns null when only a bottom bound exists (top is unbounded)', () => {
        expect(extrusionBounds({ bottomAltitude: 300 })).toBeNull();
    });

    it('returns null for a non-positive top altitude', () => {
        expect(extrusionBounds({ topAltitude: 0 })).toBeNull();
        expect(extrusionBounds({ topAltitude: -500, bottomAltitude: -1000 })).toBeNull();
    });

    it('clamps the base into [0, top]', () => {
        expect(extrusionBounds({ topAltitude: 1000, bottomAltitude: -200 }))
            .toEqual({ top: 1000, base: 0 });
        expect(extrusionBounds({ topAltitude: 1000, bottomAltitude: 5000 }))
            .toEqual({ top: 1000, base: 1000 });
    });
});
