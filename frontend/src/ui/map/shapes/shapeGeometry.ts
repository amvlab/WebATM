/**
 * DOM-free geometry helpers for the box and circle drawing tools, shared by
 * the command builder (radius for the CIRCLE command) and the drawing
 * preview (rectangle corners, tessellated circle ring). Kept separate so
 * they stay unit-testable in isolation.
 */

/** A geographic point in {lat, lng} form (BaseDrawingManager's DrawingPoint). */
export interface GeoPoint {
    lat: number;
    lng: number;
}

/** Mean Earth radius in nautical miles (6371 km, BlueSky's convention). */
const EARTH_RADIUS_NM = 6371.0 / 1.852;

/**
 * Number of segments used to preview a circle as a polygon ring. Matches the
 * backend's CIRCLE tessellation (proxy/handlers/shapes.py) so the preview
 * looks like what the server will render back.
 */
export const CIRCLE_PREVIEW_SEGMENTS = 72;

/** Great-circle (haversine) distance between two points in nautical miles. */
export function distanceNm(a: GeoPoint, b: GeoPoint): number {
    const toRad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toRad;
    const dLng = (b.lng - a.lng) * toRad;
    const sinLat = Math.sin(dLat / 2);
    const sinLng = Math.sin(dLng / 2);
    const h = sinLat * sinLat
        + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * sinLng * sinLng;
    return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Expand two opposite corners of an axis-aligned box (BlueSky BOX semantics)
 * into its four corners, in ring order.
 */
export function boxCornerPoints(a: GeoPoint, b: GeoPoint): GeoPoint[] {
    return [
        { lat: a.lat, lng: a.lng },
        { lat: a.lat, lng: b.lng },
        { lat: b.lat, lng: b.lng },
        { lat: b.lat, lng: a.lng },
    ];
}

/**
 * Tessellate a circle (centre + radius in nautical miles) into a polygon
 * ring using the same equirectangular approximation as the backend's
 * CIRCLE-to-POLY conversion, so the preview matches the rendered result.
 */
export function circleRingPoints(
    center: GeoPoint,
    radiusNm: number,
    segments: number = CIRCLE_PREVIEW_SEGMENTS
): GeoPoint[] {
    const dLat = radiusNm / 60.0; // 1 arc-minute of latitude == 1 nm
    const cosLat = Math.cos(center.lat * (Math.PI / 180));
    const ring: GeoPoint[] = [];
    for (let i = 0; i < segments; i++) {
        const theta = (2 * Math.PI * i) / segments;
        // Near the poles cos(lat) -> 0; fall back to the centre longitude
        // rather than dividing by ~0 and producing an absurd offset.
        const lng = Math.abs(cosLat) > 1e-9
            ? center.lng + (dLat * Math.sin(theta)) / cosLat
            : center.lng;
        ring.push({ lat: center.lat + dLat * Math.cos(theta), lng });
    }
    return ring;
}
