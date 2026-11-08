/**
 * Tests for the openap aircraft-type helpers shared by the console
 * autocomplete, the CRE/MCRE type warning, and the Create Aircraft modal.
 */
import { describe, it, expect } from 'vitest';
import {
    OPENAP_AIRCRAFT_TYPES,
    isOpenapAircraftType,
    hasOpenapTypeCandidates,
} from './aircraftTypes';

describe('isOpenapAircraftType', () => {
    it('matches listed types case-insensitively', () => {
        expect(isOpenapAircraftType('A320')).toBe(true);
        expect(isOpenapAircraftType('a320')).toBe(true);
        expect(isOpenapAircraftType('b77w')).toBe(true);
    });

    it('rejects unknown types and empty input', () => {
        expect(isOpenapAircraftType('ZZZZ')).toBe(false);
        expect(isOpenapAircraftType('')).toBe(false);
        // A partial of a listed type is not itself a listed type.
        expect(isOpenapAircraftType('A3')).toBe(false);
    });
});

describe('hasOpenapTypeCandidates', () => {
    it('accepts prefixes of listed types', () => {
        expect(hasOpenapTypeCandidates('A3')).toBe(true);
        expect(hasOpenapTypeCandidates('b7')).toBe(true);
    });

    it('accepts substrings, matching the dropdown contains-ranking', () => {
        expect(hasOpenapTypeCandidates('320')).toBe(true);
        expect(hasOpenapTypeCandidates('75L')).toBe(true);
    });

    it('accepts every full listed type', () => {
        for (const type of OPENAP_AIRCRAFT_TYPES) {
            expect(hasOpenapTypeCandidates(type)).toBe(true);
        }
    });

    it('rejects values no listed type contains', () => {
        expect(hasOpenapTypeCandidates('ZZ')).toBe(false);
        expect(hasOpenapTypeCandidates('A3200')).toBe(false);
    });

    it('treats empty input as "anything can still match"', () => {
        expect(hasOpenapTypeCandidates('')).toBe(true);
    });
});
