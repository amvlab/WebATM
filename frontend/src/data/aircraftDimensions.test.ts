/**
 * Tests for real-world aircraft dimension resolution used by 3D sizing.
 */
import { describe, it, expect } from 'vitest';
import {
    CATEGORY_DIMENSIONS,
    DEFAULT_DIMENSIONS,
    ICAO_DIMENSIONS,
    getDimensionsForAircraftType,
    getRealMaxExtent,
} from './aircraftDimensions';

describe('getRealMaxExtent', () => {
    it('returns the larger of length and wingspan', () => {
        expect(getRealMaxExtent({ length: 37.57, wingspan: 35.8 })).toBe(37.57);
        expect(getRealMaxExtent({ length: 72.72, wingspan: 79.75 })).toBe(79.75);
    });
});

describe('getDimensionsForAircraftType', () => {
    it('returns exact ICAO dimensions when the type is known', () => {
        expect(getDimensionsForAircraftType('A320')).toEqual(ICAO_DIMENSIONS.A320);
    });

    it('matches ICAO codes case-insensitively', () => {
        expect(getDimensionsForAircraftType('a320')).toEqual(ICAO_DIMENSIONS.A320);
    });

    it('falls back to default dimensions for a completely unknown type', () => {
        expect(getDimensionsForAircraftType('ZZZZ')).toEqual(DEFAULT_DIMENSIONS);
    });

    it('falls back to default dimensions for null/undefined/empty input', () => {
        expect(getDimensionsForAircraftType(null)).toEqual(DEFAULT_DIMENSIONS);
        expect(getDimensionsForAircraftType(undefined)).toEqual(DEFAULT_DIMENSIONS);
        expect(getDimensionsForAircraftType('')).toEqual(DEFAULT_DIMENSIONS);
    });

    it('exposes a representative dimension for every category', () => {
        for (const dims of Object.values(CATEGORY_DIMENSIONS)) {
            expect(dims.length).toBeGreaterThan(0);
            expect(dims.wingspan).toBeGreaterThan(0);
        }
    });
});
