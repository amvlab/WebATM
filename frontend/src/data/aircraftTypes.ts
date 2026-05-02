/**
 * Aircraft types supported by the openap Python library.
 *
 * Mirrors `openap.prop.available_aircraft()` (uppercased). Used by the
 * console autocomplete and the manual "Create Aircraft" modal so the user
 * can quickly pick a supported type. Users can still enter custom types
 * not in this list; the UI only warns, it does not block.
 */
export const OPENAP_AIRCRAFT_TYPES: readonly string[] = [
    'A19N', 'A20N', 'A21N', 'A318', 'A319', 'A320', 'A321',
    'A332', 'A333', 'A343', 'A359', 'A388',
    'B37M', 'B38M', 'B39M', 'B3XM',
    'B734', 'B737', 'B738', 'B739',
    'B744', 'B748', 'B752', 'B763',
    'B772', 'B773', 'B77W', 'B788', 'B789',
    'C550', 'CRJ9', 'E145', 'E170', 'E190', 'E195', 'E75L', 'GLF6'
];

/**
 * Returns true when the given aircraft type string is present in the
 * openap list (case-insensitive).
 */
export function isOpenapAircraftType(type: string): boolean {
    if (!type) return false;
    const upper = type.toUpperCase();
    return OPENAP_AIRCRAFT_TYPES.some(t => t === upper);
}
