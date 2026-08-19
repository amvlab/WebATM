import { describe, it, expect } from 'vitest';
import { buildShapeCommand, parseAltitudeInputs } from './shapeCommand';

describe('parseAltitudeInputs', () => {
    it('accepts both fields empty (no vertical extent)', () => {
        expect(parseAltitudeInputs('', '')).toEqual({ ok: true, top: null, bottom: null });
        expect(parseAltitudeInputs('  ', ' ')).toEqual({ ok: true, top: null, bottom: null });
    });

    it('accepts a valid top/bottom pair, trimming whitespace', () => {
        expect(parseAltitudeInputs(' 10000 ', '2000')).toEqual({ ok: true, top: 10000, bottom: 2000 });
    });

    it('rejects a half-filled pair instead of silently dropping it', () => {
        expect(parseAltitudeInputs('10000', '')).toEqual({
            ok: false,
            error: 'Enter both top and bottom altitudes, or leave both empty'
        });
        expect(parseAltitudeInputs('', '2000')).toMatchObject({ ok: false });
    });

    it('rejects non-numeric values instead of passing NaN through', () => {
        expect(parseAltitudeInputs('abc', '2000')).toEqual({
            ok: false,
            error: 'Altitudes must be numbers (in feet)'
        });
        expect(parseAltitudeInputs('10000', '20oo')).toMatchObject({ ok: false });
        expect(parseAltitudeInputs('Infinity', '2000')).toMatchObject({ ok: false });
    });

    it('rejects top at or below bottom', () => {
        expect(parseAltitudeInputs('2000', '10000')).toEqual({
            ok: false,
            error: 'Top altitude must be greater than bottom altitude'
        });
        expect(parseAltitudeInputs('2000', '2000')).toMatchObject({ ok: false });
    });
});

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

    it('builds a BOX from two opposite corners without altitudes', () => {
        const cmd = buildShapeCommand({
            name: 'B1',
            type: 'box',
            points: [{ lat: 52, lng: 4 }, { lat: 53, lng: 5.5 }],
            topAltitude: null,
            bottomAltitude: null
        });
        expect(cmd).toBe('BOX B1,52.000000,4.000000,53.000000,5.500000');
    });

    it('builds a BOX with trailing top,bottom altitudes', () => {
        const cmd = buildShapeCommand({
            name: 'B2',
            type: 'box',
            points: [{ lat: 52, lng: 4 }, { lat: 53, lng: 5.5 }],
            topAltitude: 10000,
            bottomAltitude: 2000
        });
        expect(cmd).toBe('BOX B2,52.000000,4.000000,53.000000,5.500000,10000,2000');
    });

    it('builds a CIRCLE from centre + rim point with the radius in nm', () => {
        // Rim due north of the centre: 1 degree of latitude ~= 60.04 nm
        // (haversine on the 6371 km mean Earth radius).
        const cmd = buildShapeCommand({
            name: 'C1',
            type: 'circle',
            points: [{ lat: 52, lng: 4 }, { lat: 53, lng: 4 }],
            topAltitude: null,
            bottomAltitude: null
        });
        const match = cmd.match(/^CIRCLE C1,52\.000000,4\.000000,(\d+\.\d{3})$/);
        expect(match).not.toBeNull();
        expect(parseFloat(match![1])).toBeCloseTo(60.04, 1);
    });

    it('builds a CIRCLE with trailing top,bottom altitudes', () => {
        const cmd = buildShapeCommand({
            name: 'C2',
            type: 'circle',
            points: [{ lat: 0, lng: 0 }, { lat: 0.5, lng: 0 }],
            topAltitude: 5000,
            bottomAltitude: 1000
        });
        expect(cmd).toMatch(/^CIRCLE C2,0\.000000,0\.000000,\d+\.\d{3},5000,1000$/);
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
