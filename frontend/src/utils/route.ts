/**
 * Route helpers shared by the 2D and 3D aircraft route renderers.
 */

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
