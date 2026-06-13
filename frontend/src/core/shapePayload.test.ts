/**
 * Tests for the poly/polyline payload normalization that SocketManager
 * uses for both shape socket events.
 */
import { describe, it, expect } from 'vitest';
import { parseShapePayload, hasValidLatLon } from './shapePayload';

const shape = (name: string) => ({ name, lat: [52, 53], lon: [4, 5] });
type TestShape = ReturnType<typeof shape>;

describe('hasValidLatLon', () => {
    it('accepts shapes with non-empty lat and lon arrays', () => {
        expect(hasValidLatLon(shape('a'))).toBe(true);
    });

    it('rejects null, non-objects, missing or empty coordinate arrays', () => {
        expect(hasValidLatLon(null)).toBe(false);
        expect(hasValidLatLon('shape')).toBe(false);
        expect(hasValidLatLon({ lat: [52] })).toBe(false);
        expect(hasValidLatLon({ lat: [], lon: [] })).toBe(false);
        expect(hasValidLatLon({ lat: 52, lon: 4 })).toBe(false);
    });
});

describe('parseShapePayload - dictionary format', () => {
    it('extracts all valid shapes from a polys dictionary', () => {
        const result = parseShapePayload<TestShape>({ polys: { a: shape('a'), b: shape('b') } });
        expect(result.validShapes.map(s => s.name)).toEqual(['a', 'b']);
        expect(result.firstShape).toEqual(shape('a'));
        expect(result.skipped).toEqual([]);
        expect(result.isEmpty).toBe(false);
    });

    it('skips invalid entries by name but keeps valid ones', () => {
        const result = parseShapePayload<TestShape>({
            polys: { bad: { lat: [], lon: [] }, good: shape('good') },
        });
        expect(result.validShapes.map(s => s.name)).toEqual(['good']);
        expect(result.skipped).toEqual(['bad']);
    });

    it('reports the first dict entry as firstShape even when invalid', () => {
        const result = parseShapePayload({
            polys: { bad: { lat: [], lon: [] }, good: shape('good') },
        });
        expect(result.firstShape).toEqual({ lat: [], lon: [] });
    });

    it('flags an empty or invalid dictionary envelope as empty', () => {
        expect(parseShapePayload({ polys: {} }).isEmpty).toBe(true);
        expect(parseShapePayload({ polys: null }).isEmpty).toBe(true);
        expect(parseShapePayload({ polys: 'nope' }).isEmpty).toBe(true);
    });
});

describe('parseShapePayload - legacy formats', () => {
    it('handles a single shape', () => {
        const result = parseShapePayload(shape('solo'));
        expect(result.validShapes).toEqual([shape('solo')]);
        expect(result.firstShape).toEqual(shape('solo'));
        expect(result.isEmpty).toBe(false);
    });

    it('handles an array of shapes, skipping invalid ones by index', () => {
        const result = parseShapePayload<TestShape>([shape('a'), { lat: [] }, shape('c')]);
        expect(result.validShapes.map(s => s.name)).toEqual(['a', 'c']);
        expect(result.skipped).toEqual(['#1']);
        expect(result.firstShape).toEqual(shape('a'));
    });

    it('handles null and empty arrays without throwing', () => {
        const nullResult = parseShapePayload(null);
        expect(nullResult.validShapes).toEqual([]);
        expect(nullResult.firstShape).toBeUndefined();
        expect(nullResult.skipped).toEqual(['#0']);

        const emptyResult = parseShapePayload([]);
        expect(emptyResult.validShapes).toEqual([]);
        expect(emptyResult.firstShape).toBeUndefined();
    });
});
