/**
 * Characterization tests for DataProcessor.
 *
 * These pin the current conversion/formatting behavior so refactors that
 * route more call sites through DataProcessor can't silently change what
 * users see. BlueSky wire units (screenio.py sends bs.traf.* unconverted,
 * i.e. SI): speed in m/s, altitude in meters, vertical speed in m/s.
 */
import { describe, it, expect } from 'vitest';
import { DataProcessor } from './DataProcessor';
import { AircraftData } from './types';

describe('DataProcessor.convertSpeed', () => {
    it('converts m/s to knots', () => {
        // 300 kt CAS arrives on the wire as 154.3332 m/s
        expect(DataProcessor.convertSpeed(154.3332, 'knots')).toBeCloseTo(300, 4);
    });

    it('returns m/s unchanged', () => {
        expect(DataProcessor.convertSpeed(100, 'm/s')).toBe(100);
    });

    it('converts m/s to km/h', () => {
        expect(DataProcessor.convertSpeed(100, 'km/h')).toBeCloseTo(360, 4);
    });

    it('converts m/s to mph', () => {
        expect(DataProcessor.convertSpeed(100, 'mph')).toBeCloseTo(223.6936, 4);
    });
});

describe('DataProcessor.formatSpeed', () => {
    it('rounds and appends the unit label', () => {
        expect(DataProcessor.formatSpeed(154.3332, 'knots')).toBe('300 kt');
        expect(DataProcessor.formatSpeed(100, 'm/s')).toBe('100 m/s');
        expect(DataProcessor.formatSpeed(100, 'km/h')).toBe('360 km/h');
        expect(DataProcessor.formatSpeed(100, 'mph')).toBe('224 mph');
    });
});

describe('DataProcessor.convertAltitude', () => {
    it('returns meters unchanged', () => {
        expect(DataProcessor.convertAltitude(3000, 'm')).toBe(3000);
    });

    it('converts meters to km', () => {
        expect(DataProcessor.convertAltitude(3000, 'km')).toBe(3);
    });

    it('converts meters to feet', () => {
        expect(DataProcessor.convertAltitude(304.8, 'ft')).toBeCloseTo(1000, 6);
    });

    it('converts meters to flight level (hundreds of feet)', () => {
        expect(DataProcessor.convertAltitude(3048, 'fl')).toBeCloseTo(100, 6);
    });
});

describe('DataProcessor.formatAltitude', () => {
    it('formats meters and feet rounded with unit label', () => {
        expect(DataProcessor.formatAltitude(3000.4, 'm')).toBe('3000 m');
        expect(DataProcessor.formatAltitude(304.8, 'ft')).toBe('1000 ft');
    });

    it('formats km with two decimals', () => {
        expect(DataProcessor.formatAltitude(3456, 'km')).toBe('3.46 km');
    });

    it('zero-pads flight levels to three digits', () => {
        expect(DataProcessor.formatAltitude(1066.8, 'fl')).toBe('FL035');
        expect(DataProcessor.formatAltitude(10668, 'fl')).toBe('FL350');
    });
});

describe('DataProcessor compact map labels', () => {
    it('formatSpeedLabel rounds and appends the suffix without a space', () => {
        expect(DataProcessor.formatSpeedLabel(154.3332, 'knots')).toBe('300kt');
        expect(DataProcessor.formatSpeedLabel(100, 'm/s')).toBe('100m/s');
        expect(DataProcessor.formatSpeedLabel(100, 'km/h')).toBe('360km/h');
        expect(DataProcessor.formatSpeedLabel(100, 'mph')).toBe('224mph');
    });

    it('formatAltitudeLabel uses zero-padded FL, one-decimal km, integer ft/m', () => {
        expect(DataProcessor.formatAltitudeLabel(1066.8, 'fl')).toBe('FL035');
        expect(DataProcessor.formatAltitudeLabel(3456, 'km')).toBe('3.5km');
        expect(DataProcessor.formatAltitudeLabel(304.8, 'ft')).toBe('1000ft');
        expect(DataProcessor.formatAltitudeLabel(3000.4, 'm')).toBe('3000m');
    });

    it('altitudeUnitLabel returns the display suffix for each unit', () => {
        expect(DataProcessor.altitudeUnitLabel('ft')).toBe('ft');
        expect(DataProcessor.altitudeUnitLabel('m')).toBe('m');
        expect(DataProcessor.altitudeUnitLabel('km')).toBe('km');
        expect(DataProcessor.altitudeUnitLabel('fl')).toBe('FL');
    });
});

describe('DataProcessor.convertVerticalSpeed', () => {
    it('returns m/s unchanged', () => {
        expect(DataProcessor.convertVerticalSpeed(10, 'm/s')).toBe(10);
    });

    it('converts m/s to m/min', () => {
        expect(DataProcessor.convertVerticalSpeed(10, 'm/min')).toBe(600);
    });

    it('converts m/s to ft/min', () => {
        // 5.08 m/s is exactly 1000 ft/min
        expect(DataProcessor.convertVerticalSpeed(5.08, 'ft/min')).toBeCloseTo(1000, 6);
    });
});

describe('DataProcessor.formatVerticalSpeed', () => {
    it('rounds and appends the unit label', () => {
        expect(DataProcessor.formatVerticalSpeed(10, 'm/s')).toBe('10 m/s');
        expect(DataProcessor.formatVerticalSpeed(10, 'm/min')).toBe('600 m/min');
        expect(DataProcessor.formatVerticalSpeed(5.08, 'ft/min')).toBe('1000 ft/min');
    });
});

describe('DataProcessor.getSpeedValue', () => {
    const aircraft = (overrides: Partial<AircraftData>): AircraftData =>
        ({
            id: ['AC1'],
            lat: [52],
            lon: [4],
            tas: [200],
            ...overrides,
        }) as AircraftData;

    it('returns CAS when available', () => {
        const data = aircraft({ cas: [180] });
        expect(DataProcessor.getSpeedValue(data, 0, 'cas')).toBe(180);
    });

    it('falls back to TAS when CAS is missing', () => {
        const data = aircraft({});
        expect(DataProcessor.getSpeedValue(data, 0, 'cas')).toBe(200);
    });

    it('returns TAS for tas type, 0 when missing', () => {
        expect(DataProcessor.getSpeedValue(aircraft({}), 0, 'tas')).toBe(200);
        expect(DataProcessor.getSpeedValue(aircraft({ tas: [] }), 0, 'tas')).toBe(0);
    });

    it('falls back gs -> tas -> cas for ground speed', () => {
        expect(DataProcessor.getSpeedValue(aircraft({ gs: [210] }), 0, 'gs')).toBe(210);
        expect(DataProcessor.getSpeedValue(aircraft({}), 0, 'gs')).toBe(200);
        expect(
            DataProcessor.getSpeedValue(aircraft({ tas: [], cas: [190] }), 0, 'gs')
        ).toBe(190);
    });

    it('keeps a genuine 0 kt instead of falling back', () => {
        // A stationary/held aircraft has speed 0 — valid data, not missing.
        expect(DataProcessor.getSpeedValue(aircraft({ cas: [0], tas: [200] }), 0, 'cas')).toBe(0);
        expect(DataProcessor.getSpeedValue(aircraft({ gs: [0], tas: [200] }), 0, 'gs')).toBe(0);
        expect(DataProcessor.getSpeedValue(aircraft({ tas: [0] }), 0, 'tas')).toBe(0);
    });
});

describe('DataProcessor reverse conversions (for BlueSky commands)', () => {
    it('speedToKnots converts a displayed value back to knots for every unit', () => {
        // Display a wire speed of 154.3332 m/s (300 kt) in each unit, then
        // convert the displayed value back for a command: always 300 kt.
        const units = ['knots', 'm/s', 'km/h', 'mph'] as const;
        for (const unit of units) {
            const displayed = DataProcessor.convertSpeed(154.3332, unit);
            expect(DataProcessor.speedToKnots(displayed, unit)).toBeCloseTo(300, 1);
        }
    });

    it('altitudeToFeet converts from each altitude unit', () => {
        expect(DataProcessor.altitudeToFeet(1000, 'ft')).toBe(1000);
        expect(DataProcessor.altitudeToFeet(304.8, 'm')).toBeCloseTo(1000, 6);
        expect(DataProcessor.altitudeToFeet(0.3048, 'km')).toBeCloseTo(1000, 6);
        expect(DataProcessor.altitudeToFeet(350, 'fl')).toBe(35000);
    });
});
