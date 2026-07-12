/**
 * DataProcessor - Unit conversion and data formatting utilities
 *
 * Provides centralized unit conversion for display across the application.
 * BlueSky server sends data in specific units:
 * - Speed: knots (kt)
 * - Altitude: meters (m)
 * - Vertical Speed: feet per second (ft/s)
 */

import { AircraftData, SpeedType, SpeedUnit, AltitudeUnit, VerticalSpeedUnit } from './types';

export class DataProcessor {
    /**
     * Convert speed from knots to target unit
     */
    static convertSpeed(speedKnots: number, targetUnit: SpeedUnit): number {
        switch (targetUnit) {
            case 'm/s':
                return speedKnots * 0.514444;
            case 'km/h':
                return speedKnots * 1.852;
            case 'mph':
                return speedKnots * 1.15078;
            case 'knots':
            default:
                return speedKnots;
        }
    }

    /**
     * Format speed value with unit label
     */
    static formatSpeed(speedKnots: number, unit: SpeedUnit): string {
        const converted = this.convertSpeed(speedKnots, unit);
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
                return altMeters / 0.3048;
            case 'fl':
                return (altMeters / 0.3048) / 100; // Convert to feet, then to Flight Level
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
     * Convert vertical speed from feet per second to target unit
     */
    static convertVerticalSpeed(vsFtPerSec: number, targetUnit: VerticalSpeedUnit): number {
        switch (targetUnit) {
            case 'm/s':
                return vsFtPerSec * 0.3048;
            case 'm/min':
                return vsFtPerSec * 18.288;
            case 'ft/min':
                return vsFtPerSec * 60;
            default:
                return vsFtPerSec;
        }
    }

    /**
     * Format vertical speed value with unit label
     */
    static formatVerticalSpeed(vsFtPerSec: number, unit: VerticalSpeedUnit): string {
        const converted = this.convertVerticalSpeed(vsFtPerSec, unit);
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
    static formatSpeedLabel(speedKnots: number, unit: SpeedUnit): string {
        const rounded = Math.round(this.convertSpeed(speedKnots, unit));
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
     * Get speed value for aircraft based on speed type (CAS/TAS/GS).
     * Falls back to other speeds only when a field is absent — a genuine
     * 0 kt (stationary/held aircraft) is a valid value, not missing data.
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
     * Reverse conversion: Convert speed from any unit to knots (for BlueSky commands)
     */
    static speedToKnots(value: number, fromUnit: SpeedUnit): number {
        switch (fromUnit) {
            case 'm/s':
                return value / 0.514444;
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
     * Reverse conversion: Convert altitude from any unit to feet (for BlueSky commands)
     */
    static altitudeToFeet(value: number, fromUnit: AltitudeUnit): number {
        switch (fromUnit) {
            case 'm':
                return value / 0.3048;
            case 'km':
                return value / 0.0003048;
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
