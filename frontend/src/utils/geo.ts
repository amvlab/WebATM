/**
 * Great-circle geodesy helpers shared by the map drawing modes.
 */

/**
 * Aviation bearing from (lat1, lon1) to (lat2, lon2). 0° = North,
 * clockwise. Returns a value in [0, 360).
 */
export function computeBearing(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
): number {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const phi1 = toRad(lat1);
    const phi2 = toRad(lat2);
    const dLon = toRad(lon2 - lon1);

    const y = Math.sin(dLon) * Math.cos(phi2);
    const x =
        Math.cos(phi1) * Math.sin(phi2) -
        Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);

    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * computeBearing rounded to a whole degree, normalized so 359.6° reads as
 * 0° rather than 360°. This is the value shown in heading readouts and
 * written into CRE commands.
 */
export function roundedBearing(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
): number {
    return Math.round(computeBearing(lat1, lon1, lat2, lon2)) % 360;
}
