/**
 * Real-world aircraft dimensions for 3D model sizing.
 *
 * Values are generated from openap.prop.aircraft(icao):
 *   length  = fuselage.length (m)
 *   wingspan = wing.span (m)
 *
 * The renderer scales each GLB so its largest bounding-box axis equals
 * max(length, wingspan) in meters. This makes relative sizes between
 * types physically correct (e.g. A380 ≈ 2.2× A320 wingspan) regardless
 * of the units the GLB was authored in.
 */

import { getAircraftCategory, type AircraftCategory } from './aircraftCategories';

export interface AircraftDimensions {
    length: number;   // fuselage length, meters
    wingspan: number; // wing span, meters
}

export const ICAO_DIMENSIONS: Readonly<Record<string, AircraftDimensions>> = {
    C550: { length: 14.39, wingspan: 15.9 },
    GLF6: { length: 30.41, wingspan: 30.36 },
    CRJ9: { length: 33.5, wingspan: 23.24 },
    E145: { length: 29.87, wingspan: 20.04 },
    E170: { length: 29.9, wingspan: 26.0 },
    E190: { length: 36.24, wingspan: 28.72 },
    E195: { length: 38.65, wingspan: 28.72 },
    E75L: { length: 29.9, wingspan: 26.0 },
    B37M: { length: 33.6, wingspan: 34.32 },
    B38M: { length: 39.47, wingspan: 34.32 },
    B39M: { length: 42.11, wingspan: 34.32 },
    B3XM: { length: 43.8, wingspan: 34.32 },
    B734: { length: 33.4, wingspan: 28.88 },
    B737: { length: 33.6, wingspan: 34.32 },
    B738: { length: 39.47, wingspan: 34.32 },
    B739: { length: 42.11, wingspan: 34.32 },
    A318: { length: 31.44, wingspan: 34.1 },
    A319: { length: 33.84, wingspan: 35.8 },
    A320: { length: 37.57, wingspan: 35.8 },
    A321: { length: 44.51, wingspan: 35.8 },
    A19N: { length: 33.84, wingspan: 35.8 },
    A20N: { length: 37.57, wingspan: 35.8 },
    A21N: { length: 44.51, wingspan: 35.8 },
    B752: { length: 47.3, wingspan: 38.0 },
    B763: { length: 54.94, wingspan: 47.57 },
    A332: { length: 58.82, wingspan: 60.3 },
    A333: { length: 63.67, wingspan: 60.3 },
    A359: { length: 66.8, wingspan: 64.75 },
    B772: { length: 63.73, wingspan: 60.93 },
    B773: { length: 73.86, wingspan: 60.93 },
    B77W: { length: 73.86, wingspan: 64.8 },
    B788: { length: 56.72, wingspan: 60.12 },
    B789: { length: 62.81, wingspan: 60.12 },
    A343: { length: 63.69, wingspan: 60.3 },
    A388: { length: 72.72, wingspan: 79.75 },
    B744: { length: 70.66, wingspan: 64.4 },
    B748: { length: 76.3, wingspan: 68.4 },
};

/**
 * Per-category fallback dimensions for ICAO codes not in the table above.
 * Chosen as a representative mid-size member of each category.
 */
export const CATEGORY_DIMENSIONS: Readonly<Record<AircraftCategory, AircraftDimensions>> = {
    bizjet: { length: 14.39, wingspan: 15.9 },          // ~C550
    regional: { length: 36.24, wingspan: 28.72 },       // ~E190
    narrow: { length: 37.57, wingspan: 35.8 },          // ~A320
    widebody_twin: { length: 66.8, wingspan: 64.75 },   // ~A359
    widebody_quad: { length: 72.72, wingspan: 79.75 },  // ~A388
};

/**
 * Default dimensions for unknown aircraft (roughly an A320).
 */
export const DEFAULT_DIMENSIONS: AircraftDimensions = { length: 37.57, wingspan: 35.8 };

/**
 * Largest real-world extent of the aircraft in meters. Used as the
 * scale target so the model's largest bounding-box axis matches the
 * aircraft's largest physical dimension.
 */
export function getRealMaxExtent(dims: AircraftDimensions): number {
    return Math.max(dims.length, dims.wingspan);
}

/**
 * Resolve real-world dimensions for an aircraft type. Falls back to
 * category dimensions when the ICAO is unknown but the category can
 * be inferred, and to a generic narrow-body as a last resort.
 */
export function getDimensionsForAircraftType(
    actype: string | undefined | null,
): AircraftDimensions {
    if (actype) {
        const dims = ICAO_DIMENSIONS[actype.toUpperCase()];
        if (dims) return dims;
    }
    const category = getAircraftCategory(actype);
    if (category !== null) return CATEGORY_DIMENSIONS[category];
    return DEFAULT_DIMENSIONS;
}
