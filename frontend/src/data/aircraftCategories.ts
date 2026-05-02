/**
 * Aircraft category classification for 3D model selection.
 *
 * openap does not expose a size category directly, but the raw
 * `fuselage.width` and `engine.number` fields from
 * `openap.prop.aircraft(icao)` cluster cleanly into five buckets:
 *
 *   width < 2.5 m                       -> bizjet
 *   2.5 m <= width < 3.2 m              -> regional
 *   3.2 m <= width < 4.5 m              -> narrow
 *   width >= 4.5 m, engines >= 4        -> widebody_quad
 *   width >= 4.5 m                      -> widebody_twin
 *
 * This table was generated from the openap 2.5 dataset.
 */
/**
 * Sentinel value for `selectedAircraftModel` that enables per-type
 * automatic model selection. Any other value forces every aircraft
 * to be rendered with that exact model file.
 */
export const AUTO_MODEL_SENTINEL = '__auto__';

export type AircraftCategory =
    | 'bizjet'
    | 'regional'
    | 'narrow'
    | 'widebody_twin'
    | 'widebody_quad';

export const ICAO_TO_CATEGORY: Readonly<Record<string, AircraftCategory>> = {
    // Bizjets (fuselage width < 2.5 m)
    C550: 'bizjet',
    GLF6: 'bizjet',

    // Regional (2.5-3.2 m)
    CRJ9: 'regional',
    E145: 'regional',
    E170: 'regional',
    E190: 'regional',
    E195: 'regional',
    E75L: 'regional',

    // Narrow-body (3.2-4.5 m)
    B37M: 'narrow', B38M: 'narrow', B39M: 'narrow', B3XM: 'narrow',
    B734: 'narrow', B737: 'narrow', B738: 'narrow', B739: 'narrow',
    A318: 'narrow', A319: 'narrow', A320: 'narrow', A321: 'narrow',
    A19N: 'narrow', A20N: 'narrow', A21N: 'narrow',
    B752: 'narrow',

    // Widebody twin (>= 4.5 m, 2 engines)
    B763: 'widebody_twin',
    A332: 'widebody_twin', A333: 'widebody_twin',
    A359: 'widebody_twin',
    B772: 'widebody_twin', B773: 'widebody_twin', B77W: 'widebody_twin',
    B788: 'widebody_twin', B789: 'widebody_twin',

    // Widebody quad (>= 4.5 m, 4 engines)
    A343: 'widebody_quad',
    A388: 'widebody_quad',
    B744: 'widebody_quad', B748: 'widebody_quad',
};

/**
 * Default GLTF/GLB filename per category. Files live under
 * `/static/models/aircraft/`. Categories without a bespoke asset
 * fall back to a representative of an adjacent size class.
 */
export const CATEGORY_TO_MODEL: Readonly<Record<AircraftCategory, string>> = {
    bizjet: 'A320.glb',
    regional: 'A320.glb',
    narrow: 'A320.glb',
    widebody_twin: 'A350.glb',
    widebody_quad: 'A380.glb',
};

export function getAircraftCategory(actype: string | undefined | null): AircraftCategory | null {
    if (!actype) return null;
    return ICAO_TO_CATEGORY[actype.toUpperCase()] ?? null;
}

/**
 * Resolve the 3D model filename for an aircraft type, falling back
 * to `fallbackModel` when the type is unknown or missing.
 */
export function getModelForAircraftType(
    actype: string | undefined | null,
    fallbackModel: string
): string {
    const category = getAircraftCategory(actype);
    if (category === null) return fallbackModel;
    return CATEGORY_TO_MODEL[category];
}
