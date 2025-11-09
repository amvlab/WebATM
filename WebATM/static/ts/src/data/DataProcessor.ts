/**
 * DataProcessor - Unit conversion and data formatting utilities
 *
 * Provides centralized unit conversion for display across the application.
 * BlueSky server sends data in specific units:
 * - Speed: knots (kt)
 * - Altitude: feet (ft)
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
     * Convert altitude from feet to target unit
     */
    static convertAltitude(altFeet: number, targetUnit: AltitudeUnit): number {
        switch (targetUnit) {
            case 'm':
                return altFeet * 0.3048;
            case 'km':
                return altFeet * 0.0003048;
            case 'ft':
                return altFeet;
            case 'fl':
                return altFeet / 100; // Flight Level
            default:
                return altFeet;
        }
    }

    /**
     * Format altitude value with unit label
     */
    static formatAltitude(altFeet: number, unit: AltitudeUnit): string {
        const converted = this.convertAltitude(altFeet, unit);

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
     * Get speed value for aircraft based on speed type (CAS/TAS/GS)
     * Handles missing data gracefully with fallback to TAS
     */
    static getSpeedValue(data: AircraftData, index: number, type: SpeedType): number {
        switch (type) {
            case 'cas':
                // If CAS not available, fall back to TAS
                return (data.cas && data.cas[index]) || data.tas[index] || 0;
            case 'tas':
                return data.tas[index] || 0;
            case 'gs':
                // Fallback chain: gs -> tas -> cas
                return (data.gs && data.gs[index]) || data.tas[index] || (data.cas && data.cas[index]) || 0;
            default:
                return data.tas[index] || 0;
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
