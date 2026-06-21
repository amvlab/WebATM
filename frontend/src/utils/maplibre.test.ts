// @vitest-environment happy-dom
/**
 * Tests for the shared maplibre helpers. Runs under happy-dom because
 * importing the module pulls in maplibre-gl, which needs a DOM-ish global.
 */
import { describe, it, expect } from 'vitest';
import {
    isValidCoordinate,
    buildConditionalColorExpr,
    buildConditionalImageExpr,
} from './maplibre';

describe('isValidCoordinate', () => {
    it('accepts in-range numeric coordinates, including the boundaries', () => {
        expect(isValidCoordinate(52.3, 4.9)).toBe(true);
        expect(isValidCoordinate(0, 0)).toBe(true);
        expect(isValidCoordinate(-90, -180)).toBe(true);
        expect(isValidCoordinate(90, 180)).toBe(true);
    });

    it('rejects out-of-range latitude or longitude', () => {
        expect(isValidCoordinate(90.1, 0)).toBe(false);
        expect(isValidCoordinate(-90.1, 0)).toBe(false);
        expect(isValidCoordinate(0, 180.1)).toBe(false);
        expect(isValidCoordinate(0, -180.1)).toBe(false);
    });

    it('rejects NaN and non-numeric values', () => {
        expect(isValidCoordinate(NaN, 0)).toBe(false);
        expect(isValidCoordinate(0, NaN)).toBe(false);
        expect(isValidCoordinate(undefined, 0)).toBe(false);
        expect(isValidCoordinate('52', '4')).toBe(false);
        expect(isValidCoordinate(null, null)).toBe(false);
    });
});

describe('buildConditionalColorExpr', () => {
    it('builds a selected → normal case when no conflict color is given', () => {
        expect(buildConditionalColorExpr('#norm', '#sel')).toEqual([
            'case',
            ['==', ['get', 'selected'], true], '#sel',
            '#norm',
        ]);
    });

    it('inserts the conflict clause before the normal fallback when provided', () => {
        expect(buildConditionalColorExpr('#norm', '#sel', '#conf')).toEqual([
            'case',
            ['==', ['get', 'selected'], true], '#sel',
            ['==', ['get', 'in_conflict'], true], '#conf',
            '#norm',
        ]);
    });

    it('buildConditionalImageExpr produces the same shape', () => {
        expect(buildConditionalImageExpr('#norm', '#sel', '#conf')).toEqual(
            buildConditionalColorExpr('#norm', '#sel', '#conf')
        );
    });
});
