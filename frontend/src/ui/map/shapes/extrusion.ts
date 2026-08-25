import { PolygonShape } from '../../../data/types';

/** Vertical extent of an extruded polygon, in metres above ground. */
export interface ExtrusionBounds {
    base: number;
    top: number;
}

/**
 * Vertical extent for a polygon's 3D extrusion, or null when the shape has
 * no renderable extent and must stay flat. The backend only forwards finite
 * altitude bounds (BlueSky's +/-1e9 "unbounded" sentinels are stripped), so
 * a missing top altitude means the shape is a plain 2D area.
 *
 * A missing bottom defaults to ground level, and the base is clamped into
 * [0, top] so malformed data can never produce an inside-out extrusion.
 */
export function extrusionBounds(
    poly: Pick<PolygonShape, 'topAltitude' | 'bottomAltitude'>
): ExtrusionBounds | null {
    const top = poly.topAltitude;
    if (typeof top !== 'number' || top <= 0) return null;
    const bottom = typeof poly.bottomAltitude === 'number' ? poly.bottomAltitude : 0;
    return { top, base: Math.min(Math.max(bottom, 0), top) };
}
