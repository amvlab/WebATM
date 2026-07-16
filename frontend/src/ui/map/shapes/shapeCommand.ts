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
