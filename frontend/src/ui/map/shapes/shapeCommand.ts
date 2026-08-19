/**
 * Pure builder for the BlueSky shape command sent when a drawn shape is
 * finished. Kept DOM-free so it can be unit tested in isolation.
 */

import { distanceNm } from './shapeGeometry';

/** A drawn point in {lat, lng} form (BaseDrawingManager's DrawingPoint). */
export interface ShapePoint {
    lat: number;
    lng: number;
}

/** The shape kinds offered by the draw modal. */
export type ShapeType = 'area' | 'line' | 'circle' | 'box';

export type AltitudeParseResult =
    | { ok: true; top: number | null; bottom: number | null }
    | { ok: false; error: string };

/**
 * Parse the draw modal's optional top/bottom altitude inputs. Both empty
 * means no vertical extent; anything else needs two finite numbers with top
 * above bottom, so a non-numeric value can't leak into the generated command
 * as NaN and a half-filled pair isn't silently dropped.
 */
export function parseAltitudeInputs(topRaw: string, bottomRaw: string): AltitudeParseResult {
    const top = topRaw.trim();
    const bottom = bottomRaw.trim();

    if (!top && !bottom) {
        return { ok: true, top: null, bottom: null };
    }
    if (!top || !bottom) {
        return { ok: false, error: 'Enter both top and bottom altitudes, or leave both empty' };
    }

    const topNum = Number(top);
    const bottomNum = Number(bottom);
    if (!Number.isFinite(topNum) || !Number.isFinite(bottomNum)) {
        return { ok: false, error: 'Altitudes must be numbers (in feet)' };
    }
    if (topNum <= bottomNum) {
        return { ok: false, error: 'Top altitude must be greater than bottom altitude' };
    }
    return { ok: true, top: topNum, bottom: bottomNum };
}

export interface ShapeCommandSpec {
    name: string;
    type: ShapeType;
    /**
     * The placed points. Areas/lines use all of them; a box is its two
     * opposite corners; a circle is [centre, point-on-rim].
     */
    points: ShapePoint[];
    /** Top/bottom altitude in feet; both null = no vertical extent. */
    topAltitude: number | null;
    bottomAltitude: number | null;
}

/**
 * Build the BlueSky command for a drawn shape:
 *  - line              -> POLYLINE name,lat,lon,...
 *  - area with alts    -> POLYALT name,top,bottom,lat,lon,...
 *  - area without alts -> POLY name,lat,lon,...
 *  - box               -> BOX name,lat0,lon0,lat1,lon1[,top,bottom]
 *  - circle            -> CIRCLE name,clat,clon,radius_nm[,top,bottom]
 */
export function buildShapeCommand(spec: ShapeCommandSpec): string {
    const coords = spec.points.flatMap(p => [p.lat.toFixed(6), p.lng.toFixed(6)]);
    // BOX/CIRCLE take the vertical extent as optional trailing [top,bottom]
    // arguments (POLYALT takes them up front instead).
    const altSuffix = spec.topAltitude !== null && spec.bottomAltitude !== null
        ? `,${spec.topAltitude},${spec.bottomAltitude}`
        : '';

    if (spec.type === 'line') {
        return `POLYLINE ${spec.name},${coords.join(',')}`;
    }
    if (spec.type === 'box') {
        return `BOX ${spec.name},${coords.join(',')}${altSuffix}`;
    }
    if (spec.type === 'circle') {
        const [center, rim] = spec.points;
        const radius = distanceNm(center, rim).toFixed(3);
        return `CIRCLE ${spec.name},${center.lat.toFixed(6)},${center.lng.toFixed(6)},${radius}${altSuffix}`;
    }
    if (spec.topAltitude !== null && spec.bottomAltitude !== null) {
        return `POLYALT ${spec.name},${spec.topAltitude},${spec.bottomAltitude},${coords.join(',')}`;
    }
    return `POLY ${spec.name},${coords.join(',')}`;
}
