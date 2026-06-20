import { describe, it, expect } from 'vitest';
import { buildShapeCommand } from './shapeCommand';

describe('buildShapeCommand', () => {
    const points = [
        { lat: 1, lng: 2 },
        { lat: 3.5, lng: -4.25 },
        { lat: 5, lng: 6 }
    ];

    it('builds a POLYLINE for lines (alts ignored)', () => {
        const cmd = buildShapeCommand({
            name: 'L1',
            type: 'line',
            points: points.slice(0, 2),
            topAltitude: 1000,
            bottomAltitude: 500
        });
        expect(cmd).toBe('POLYLINE L1,1.000000,2.000000,3.500000,-4.250000');
    });

    it('builds a POLY for areas without altitudes', () => {
        const cmd = buildShapeCommand({
            name: 'A1',
            type: 'area',
            points,
            topAltitude: null,
            bottomAltitude: null
        });
        expect(cmd).toBe('POLY A1,1.000000,2.000000,3.500000,-4.250000,5.000000,6.000000');
    });

    it('builds a POLYALT for areas with both altitudes', () => {
        const cmd = buildShapeCommand({
            name: 'A2',
            type: 'area',
            points: points.slice(0, 1),
            topAltitude: 10000,
            bottomAltitude: 2000
        });
        expect(cmd).toBe('POLYALT A2,10000,2000,1.000000,2.000000');
    });

    it('falls back to POLY when only one altitude is set', () => {
        const cmd = buildShapeCommand({
            name: 'A3',
            type: 'area',
            points: points.slice(0, 1),
            topAltitude: 10000,
            bottomAltitude: null
        });
        expect(cmd).toBe('POLY A3,1.000000,2.000000');
    });

    it('formats coordinates to six decimal places', () => {
        const cmd = buildShapeCommand({
            name: 'P',
            type: 'line',
            points: [{ lat: 37.123456789, lng: -122.987654321 }],
            topAltitude: null,
            bottomAltitude: null
        });
        expect(cmd).toBe('POLYLINE P,37.123457,-122.987654');
    });
});
