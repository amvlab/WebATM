import { describe, it, expect } from 'vitest';
import {
    AUTO_MODEL_SENTINEL,
    DEFAULT_FALLBACK_MODEL,
    MODEL_DIR,
    getModelForAircraftType,
    resolveAircraftModelPath,
} from './aircraftCategories';

describe('getModelForAircraftType', () => {
    it('maps a known narrow-body to its category model', () => {
        expect(getModelForAircraftType('A320', DEFAULT_FALLBACK_MODEL)).toBe('A320.glb');
    });

    it('maps a quad widebody to the A380 model', () => {
        expect(getModelForAircraftType('A388', DEFAULT_FALLBACK_MODEL)).toBe('A380.glb');
    });

    it('is case-insensitive on the ICAO type', () => {
        expect(getModelForAircraftType('a359', DEFAULT_FALLBACK_MODEL)).toBe('A350.glb');
    });

    it('uses the dedicated 787 model for 787 variants over the category default', () => {
        expect(getModelForAircraftType('B788', DEFAULT_FALLBACK_MODEL)).toBe('B787.glb');
        expect(getModelForAircraftType('b789', DEFAULT_FALLBACK_MODEL)).toBe('B787.glb');
    });

    it('falls back for unknown or missing types', () => {
        expect(getModelForAircraftType('ZZZZ', DEFAULT_FALLBACK_MODEL)).toBe(DEFAULT_FALLBACK_MODEL);
        expect(getModelForAircraftType('', DEFAULT_FALLBACK_MODEL)).toBe(DEFAULT_FALLBACK_MODEL);
        expect(getModelForAircraftType(null, DEFAULT_FALLBACK_MODEL)).toBe(DEFAULT_FALLBACK_MODEL);
    });
});

describe('resolveAircraftModelPath', () => {
    it('lets a per-aircraft override win over auto and forced selection', () => {
        expect(resolveAircraftModelPath(AUTO_MODEL_SENTINEL, 'A320', 'B747.glb'))
            .toBe(`${MODEL_DIR}B747.glb`);
        expect(resolveAircraftModelPath('A350.glb', 'A320', 'B747.glb'))
            .toBe(`${MODEL_DIR}B747.glb`);
    });

    it('uses a globally forced model when no override is set', () => {
        expect(resolveAircraftModelPath('A380.glb', 'A320', null))
            .toBe(`${MODEL_DIR}A380.glb`);
    });

    it('resolves per-type automatically under the AUTO sentinel', () => {
        expect(resolveAircraftModelPath(AUTO_MODEL_SENTINEL, 'A388', null))
            .toBe(`${MODEL_DIR}A380.glb`);
    });

    it('treats empty/undefined selection as AUTO', () => {
        expect(resolveAircraftModelPath('', 'A359', null)).toBe(`${MODEL_DIR}A350.glb`);
        expect(resolveAircraftModelPath(undefined, 'A359')).toBe(`${MODEL_DIR}A350.glb`);
    });

    it('falls back to the default model for unknown types under AUTO', () => {
        expect(resolveAircraftModelPath(AUTO_MODEL_SENTINEL, 'ZZZZ', null))
            .toBe(`${MODEL_DIR}${DEFAULT_FALLBACK_MODEL}`);
        expect(resolveAircraftModelPath(AUTO_MODEL_SENTINEL, '', null))
            .toBe(`${MODEL_DIR}${DEFAULT_FALLBACK_MODEL}`);
    });

    it('ignores an empty-string override (treated as no override)', () => {
        expect(resolveAircraftModelPath('A380.glb', 'A320', ''))
            .toBe(`${MODEL_DIR}A380.glb`);
    });
});
