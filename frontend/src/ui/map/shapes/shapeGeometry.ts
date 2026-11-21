/**
 * DOM-free geometry helpers for the shape tools: drawing (box corners,
 * circle ring, CIRCLE radius) and rendering (label anchors). Kept separate
 * so they stay unit-testable in isolation.
 */

import { normalizeLongitude, unwrapLongitude } from '../../../utils/geo';

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

/**
 * Mean-of-vertices label anchor for a polygon ring, or null for an empty
 * ring. Longitudes are averaged unwrapped around the first vertex so a ring
 * straddling ±180 anchors on the shape rather than the far side of the
 * world, and a closing vertex equal to the first is dropped so it doesn't
 * skew the mean.
 */
export function polygonLabelAnchor(points: GeoPoint[]): GeoPoint | null {
    if (points.length === 0) return null;
    const first = points[0];
    const last = points[points.length - 1];
    const ring = points.length > 1 && last.lat === first.lat && last.lng === first.lng
        ? points.slice(0, -1)
        : points;

    let sumLat = 0;
    let sumLng = 0;
    for (const p of ring) {
        sumLat += p.lat;
        sumLng += unwrapLongitude(p.lng, first.lng);
    }
    return {
        lat: sumLat / ring.length,
        lng: normalizeLongitude(sumLng / ring.length),
    };
}

/** Middle vertex of a polyline as its label anchor, or null when empty. */
export function polylineLabelAnchor(points: GeoPoint[]): GeoPoint | null {
    if (points.length === 0) return null;
    return points[Math.floor(points.length / 2)];
}

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
