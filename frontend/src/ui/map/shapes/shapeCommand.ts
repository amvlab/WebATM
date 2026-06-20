/**
 * Pure builder for the BlueSky shape command sent when a drawn shape is
 * finished. Kept DOM-free so it can be unit tested in isolation.
 */

/** A drawn point in {lat, lng} form (BaseDrawingManager's DrawingPoint). */
export interface ShapePoint {
    lat: number;
    lng: number;
}

export interface ShapeCommandSpec {
    name: string;
    type: 'area' | 'line';
    points: ShapePoint[];
    /** Top/bottom altitude in feet; both null = unconstrained POLY. */
    topAltitude: number | null;
    bottomAltitude: number | null;
}

/**
 * Build the BlueSky command for a drawn shape:
 *  - line              -> POLYLINE name,lat,lon,...
 *  - area with alts    -> POLYALT name,top,bottom,lat,lon,...
 *  - area without alts -> POLY name,lat,lon,...
 */
export function buildShapeCommand(spec: ShapeCommandSpec): string {
    const coords = spec.points.flatMap(p => [p.lat.toFixed(6), p.lng.toFixed(6)]);

    if (spec.type === 'line') {
        return `POLYLINE ${spec.name},${coords.join(',')}`;
    }
    if (spec.topAltitude !== null && spec.bottomAltitude !== null) {
        return `POLYALT ${spec.name},${spec.topAltitude},${spec.bottomAltitude},${coords.join(',')}`;
    }
    return `POLY ${spec.name},${coords.join(',')}`;
}
