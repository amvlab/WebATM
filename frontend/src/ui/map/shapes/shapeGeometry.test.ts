import { describe, it, expect } from 'vitest';
import {
    boxCornerPoints,
    circleRingPoints,
    distanceNm,
    polygonLabelAnchor,
    polylineLabelAnchor,
    CIRCLE_PREVIEW_SEGMENTS,
} from './shapeGeometry';

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

describe('polygonLabelAnchor', () => {
    it('returns the mean of the vertices', () => {
        expect(polygonLabelAnchor([
            { lat: 0, lng: 0 },
            { lat: 2, lng: 0 },
            { lat: 2, lng: 4 },
            { lat: 0, lng: 4 },
        ])).toEqual({ lat: 1, lng: 2 });
    });

    it('ignores a closing vertex equal to the first', () => {
        expect(polygonLabelAnchor([
            { lat: 0, lng: 0 },
            { lat: 3, lng: 0 },
            { lat: 0, lng: 3 },
            { lat: 0, lng: 0 },
        ])).toEqual({ lat: 1, lng: 1 });
    });

    it('anchors a ring straddling ±180 on the shape, not at lng ~0', () => {
        const anchor = polygonLabelAnchor([
            { lat: 5, lng: 175 },
            { lat: 5, lng: -175 },
            { lat: -5, lng: -175 },
            { lat: -5, lng: 175 },
        ]);
        expect(anchor?.lat).toBe(0);
        expect(anchor?.lng).toBe(180);
    });

    it('returns null for an empty ring', () => {
        expect(polygonLabelAnchor([])).toBeNull();
    });
});

describe('polylineLabelAnchor', () => {
    it('returns the middle vertex', () => {
        expect(polylineLabelAnchor([
            { lat: 10, lng: 170 },
            { lat: 12, lng: 180 },
            { lat: 10, lng: -170 },
        ])).toEqual({ lat: 12, lng: 180 });
    });

    it('returns null for an empty line', () => {
        expect(polylineLabelAnchor([])).toBeNull();
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
