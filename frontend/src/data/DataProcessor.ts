/**
 * DataProcessor - Unit conversion and data formatting utilities
 *
 * Provides centralized unit conversion for display across the application.
 * The BlueSky server sends ACDATA/ROUTEDATA in its internal SI units
 * (bluesky/simulation/screenio.py forwards bs.traf.* arrays unconverted):
 * - Speed (tas/cas/gs): meters per second (m/s)
 * - Altitude: meters (m)
 * - Vertical Speed: meters per second (m/s)
 */

import { AircraftData, SpeedType, SpeedUnit, AltitudeUnit, VerticalSpeedUnit } from './types';

/** One knot in m/s (BlueSky's aero.kts). */
const KTS = 0.514444;
/** One foot in meters. */
const FT = 0.3048;

export class DataProcessor {
    /**
     * Convert speed from m/s (BlueSky server unit) to target unit
     */
    static convertSpeed(speedMs: number, targetUnit: SpeedUnit): number {
        switch (targetUnit) {
            case 'm/s':
                return speedMs;
            case 'km/h':
                return speedMs * 3.6;
            case 'mph':
                return speedMs * 2.236936;
            case 'knots':
            default:
                return speedMs / KTS;
        }
    }

    /**
     * Format speed value with unit label
     */
    static formatSpeed(speedMs: number, unit: SpeedUnit): string {
        const converted = this.convertSpeed(speedMs, unit);
        const rounded = Math.round(converted);

        switch (unit) {
            case 'm/s':
                return `${rounded} m/s`;
            case 'km/h':
                return `${rounded} km/h`;
            case 'mph':
                return `${rounded} mph`;
            case 'knots':
            default:
                return `${rounded} kt`;
        }
    }

    /**
     * Convert altitude from meters (BlueSky server unit) to target unit
     */
    static convertAltitude(altMeters: number, targetUnit: AltitudeUnit): number {
        switch (targetUnit) {
            case 'm':
                return altMeters;
            case 'km':
                return altMeters / 1000;
            case 'ft':
                return altMeters / FT;
            case 'fl':
                return (altMeters / FT) / 100; // Convert to feet, then to Flight Level
            default:
                return altMeters;
        }
    }

    /**
     * Format altitude value with unit label
     */
    static formatAltitude(altMeters: number, unit: AltitudeUnit): string {
        const converted = this.convertAltitude(altMeters, unit);

        switch (unit) {
            case 'm':
                return `${Math.round(converted)} m`;
            case 'km':
                return `${converted.toFixed(2)} km`;
            case 'ft':
                return `${Math.round(converted)} ft`;
            case 'fl':
                return `FL${Math.round(converted).toString().padStart(3, '0')}`;
            default:
                return `${Math.round(converted)} ft`;
        }
    }

    /**
     * Convert vertical speed from m/s (BlueSky server unit) to target unit
     */
    static convertVerticalSpeed(vsMs: number, targetUnit: VerticalSpeedUnit): number {
        switch (targetUnit) {
            case 'm/s':
                return vsMs;
            case 'm/min':
                return vsMs * 60;
            case 'ft/min':
                return (vsMs / FT) * 60;
            default:
                return vsMs;
        }
    }

    /**
     * Format vertical speed value with unit label
     */
    static formatVerticalSpeed(vsMs: number, unit: VerticalSpeedUnit): string {
        const converted = this.convertVerticalSpeed(vsMs, unit);
        const rounded = Math.round(converted);

        switch (unit) {
            case 'm/s':
                return `${rounded} m/s`;
            case 'm/min':
                return `${rounded} m/min`;
            case 'ft/min':
                return `${rounded} ft/min`;
            default:
                return `${rounded} m/s`;
        }
    }

    /**
     * Altitude unit suffix for labels (e.g. "ft", "FL").
     */
    static altitudeUnitLabel(unit: AltitudeUnit): string {
        switch (unit) {
            case 'm':
                return 'm';
            case 'km':
                return 'km';
            case 'fl':
                return 'FL';
            case 'ft':
            default:
                return 'ft';
        }
    }

    /**
     * Unit suffix used in compact map labels (e.g. "250kt").
     */
    static speedUnitLabel(unit: SpeedUnit): string {
        switch (unit) {
            case 'm/s':
                return 'm/s';
            case 'km/h':
                return 'km/h';
            case 'mph':
                return 'mph';
            case 'knots':
            default:
                return 'kt';
        }
    }

    /**
     * Compact speed label for map display (no space before the unit).
     */
    static formatSpeedLabel(speedMs: number, unit: SpeedUnit): string {
        const rounded = Math.round(this.convertSpeed(speedMs, unit));
        return `${rounded}${this.speedUnitLabel(unit)}`;
    }

    /**
     * Compact altitude label for map display: FL is zero-padded, km keeps
     * one decimal, other units round to integers with no space before the
     * unit suffix.
     */
    static formatAltitudeLabel(altMeters: number, unit: AltitudeUnit): string {
        const converted = this.convertAltitude(altMeters, unit);

        switch (unit) {
            case 'fl':
                return 'FL' + Math.round(converted).toString().padStart(3, '0');
            case 'km':
                return converted.toFixed(1) + 'km';
            case 'ft':
                return Math.round(converted).toString() + 'ft';
            case 'm':
                return Math.round(converted).toString() + 'm';
            default:
                return Math.round(converted).toString();
        }
    }

    /**
     * Get speed value (in m/s, as sent by BlueSky) for aircraft based on
     * speed type (CAS/TAS/GS). Falls back to other speeds only when a field
     * is absent — a genuine 0 (stationary/held aircraft) is a valid value,
     * not missing data.
     */
    static getSpeedValue(data: AircraftData, index: number, type: SpeedType): number {
        switch (type) {
            case 'cas':
                return data.cas?.[index] ?? data.tas[index] ?? 0;
            case 'gs':
                // Fallback chain: gs -> tas -> cas
                return data.gs?.[index] ?? data.tas[index] ?? data.cas?.[index] ?? 0;
            case 'tas':
            default:
                return data.tas[index] ?? 0;
        }
    }

    /**
     * Convert a user-entered speed from any display unit to knots (the unit
     * BlueSky commands expect). Independent of the wire format above.
     */
    static speedToKnots(value: number, fromUnit: SpeedUnit): number {
        switch (fromUnit) {
            case 'm/s':
                return value / KTS;
            case 'km/h':
                return value / 1.852;
            case 'mph':
                return value / 1.15078;
            case 'knots':
            default:
                return value;
        }
    }

    /**
     * Convert a user-entered altitude from any display unit to feet (the unit
     * BlueSky commands expect). Independent of the wire format above.
     */
    static altitudeToFeet(value: number, fromUnit: AltitudeUnit): number {
        switch (fromUnit) {
            case 'm':
                return value / FT;
            case 'km':
                return value / (FT / 1000);
            case 'ft':
                return value;
            case 'fl':
                return value * 100; // Flight Level to feet
            default:
                return value;
        }
    }
}

export default DataProcessor;
