import { describe, it, expect } from 'vitest';
import { boxCornerPoints, circleRingPoints, distanceNm, CIRCLE_PREVIEW_SEGMENTS } from './shapeGeometry';

describe('distanceNm', () => {
    it('returns 0 for identical points', () => {
        expect(distanceNm({ lat: 52, lng: 4 }, { lat: 52, lng: 4 })).toBe(0);
    });

    it('measures 1 degree of latitude as ~60 nm', () => {
        expect(distanceNm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(60.04, 1);
    });

    it('measures 1 degree of longitude at the equator as ~60 nm', () => {
        expect(distanceNm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(60.04, 1);
    });

    it('shrinks longitude distance by cos(lat) away from the equator', () => {
        const d = distanceNm({ lat: 60, lng: 0 }, { lat: 60, lng: 1 });
        expect(d).toBeCloseTo(60.04 * Math.cos(Math.PI / 3), 0);
    });
});

describe('boxCornerPoints', () => {
    it('expands two opposite corners into a 4-corner ring', () => {
        expect(boxCornerPoints({ lat: 52, lng: 4 }, { lat: 53, lng: 5 })).toEqual([
            { lat: 52, lng: 4 },
            { lat: 52, lng: 5 },
            { lat: 53, lng: 5 },
            { lat: 53, lng: 4 },
        ]);
    });
});

describe('circleRingPoints', () => {
    it('produces the requested number of ring points, all one radius from the centre', () => {
        const center = { lat: 52, lng: 4 };
        const ring = circleRingPoints(center, 10);

        expect(ring).toHaveLength(CIRCLE_PREVIEW_SEGMENTS);
        for (const point of ring) {
            // Equirectangular tessellation vs haversine check: allow a small
            // tolerance rather than exact equality.
            expect(distanceNm(center, point)).toBeCloseTo(10, 1);
        }
    });

    it('starts due north of the centre', () => {
        const ring = circleRingPoints({ lat: 52, lng: 4 }, 60);
        expect(ring[0].lat).toBeCloseTo(53, 6);
        expect(ring[0].lng).toBeCloseTo(4, 6);
    });

    it('keeps the centre longitude at the poles instead of dividing by ~0', () => {
        const ring = circleRingPoints({ lat: 90, lng: 10 }, 5);
        for (const point of ring) {
            expect(point.lng).toBe(10);
            expect(Number.isFinite(point.lat)).toBe(true);
        }
    });
});
