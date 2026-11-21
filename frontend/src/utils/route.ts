/**
 * Route helpers shared by the 2D and 3D aircraft route renderers.
 */

import type { RouteData } from '../data/types';
import { normalizeLongitude } from './geo';

const outOfRange = (lon: number): boolean => lon > 180 || lon < -180;

/**
 * Wrap a ROUTEDATA frame's longitudes into [-180, 180]. Like ACDATA
 * (see StateManager.updateAircraftData), BlueSky integrates aircraft
 * longitude unbounded after creation, so `aclon` of an aircraft that
 * crossed the antimeridian stays beyond ±180 — which isValidCoordinate
 * consumers would drop, hiding the route. Returns the input object
 * unchanged when nothing is out of range.
 */
export function normalizeRouteLongitudes(data: RouteData): RouteData {
    const needsAc = typeof data.aclon === 'number' && outOfRange(data.aclon);
    const needsWp = data.wplon?.some(outOfRange) ?? false;
    if (!needsAc && !needsWp) return data;
    return {
        ...data,
        aclon: needsAc ? normalizeLongitude(data.aclon) : data.aclon,
        wplon: needsWp ? data.wplon.map(normalizeLongitude) : data.wplon,
    };
}

/**
 * True when a ROUTEDATA frame carries waypoints. BlueSky also sends
 * waypoint-less frames ({acid} only): route-clear broadcasts when the route
 * display is toggled off, and — streamed once per second — when the displayed
 * aircraft no longer exists (`screenio._sendrte` sends just the acid when the
 * id lookup fails). Those frames must clear cached routes but never drive
 * selection.
 */
export function hasRouteWaypoints(
    data: Partial<Pick<RouteData, 'wplat'>> | null | undefined
): boolean {
    return Array.isArray(data?.wplat) && data.wplat.length > 0;
}

/**
 * Clamp BlueSky's active-waypoint index (`iactwp`) to a valid index in a
 * route of `waypointCount` waypoints. BlueSky initializes `iactwp` to -1
 * ("no active waypoint yet"), and its own GUI clamps the received value to
 * `[0, waypointCount - 1]` (bluesky/ui/qtgl/gltraffic.py); mirroring that
 * keeps WebATM's renderers consistent with the reference client and with
 * each other.
 */
export function clampActiveWaypoint(
    iactwp: number | undefined,
    waypointCount: number
): number {
    const index = typeof iactwp === 'number' && Number.isFinite(iactwp) ? iactwp : 0;
    return Math.max(0, Math.min(index, waypointCount - 1));
}
