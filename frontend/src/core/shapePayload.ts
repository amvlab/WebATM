/**
 * Pure helpers for normalizing 'poly' / 'polyline' socket payloads.
 *
 * The BlueSky proxy can deliver shape data in three formats:
 *   1. `{ polys: { name: shape, ... } }` - dictionary of shapes
 *   2. `shape`                           - a single shape
 *   3. `shape[]`                         - an array of shapes
 *
 * Both shape kinds (polygons and polylines) share this envelope and the
 * same lat/lon validation rules, so SocketManager funnels both events
 * through these helpers. DOM-free so it can be unit tested in isolation.
 */

/** Minimal structural requirement for a shape payload entry. */
export interface ShapeLike {
    lat?: number[];
    lon?: number[];
}

export interface ShapePayloadResult<T extends ShapeLike> {
    /** Shapes that passed lat/lon validation, in payload order. */
    validShapes: T[];
    /**
     * First shape in the payload regardless of validity, for the
     * backwards-compatible single-shape handlers.
     */
    firstShape: T | undefined;
    /** Labels of entries that failed validation (dict key or array index). */
    skipped: string[];
    /** True when the payload was an empty/invalid dictionary envelope. */
    isEmpty: boolean;
}

/**
 * A shape is renderable only when it carries non-empty lat AND lon arrays.
 */
export function hasValidLatLon(shape: unknown): shape is ShapeLike {
    if (!shape || typeof shape !== 'object') return false;
    const { lat, lon } = shape as ShapeLike;
    return Array.isArray(lat) && Array.isArray(lon) && lat.length > 0 && lon.length > 0;
}

/**
 * Normalize any of the three payload formats into a flat list of valid
 * shapes plus bookkeeping for logging and backwards compatibility.
 */
export function parseShapePayload<T extends ShapeLike>(data: unknown): ShapePayloadResult<T> {
    if (data && typeof data === 'object' && 'polys' in data) {
        const dict = (data as { polys: unknown }).polys;
        if (!dict || typeof dict !== 'object' || Object.keys(dict).length === 0) {
            return { validShapes: [], firstShape: undefined, skipped: [], isEmpty: true };
        }

        const validShapes: T[] = [];
        const skipped: string[] = [];
        for (const [name, shape] of Object.entries(dict)) {
            if (hasValidLatLon(shape)) {
                validShapes.push(shape as T);
            } else {
                skipped.push(name);
            }
        }
        const firstShape = (Object.values(dict)[0] as T | null) ?? undefined;
        return { validShapes, firstShape, skipped, isEmpty: false };
    }

    // Legacy format: single shape or array of shapes
    const shapes = Array.isArray(data) ? data : [data];
    const validShapes: T[] = [];
    const skipped: string[] = [];
    shapes.forEach((shape, index) => {
        if (hasValidLatLon(shape)) {
            validShapes.push(shape as T);
        } else {
            skipped.push(`#${index}`);
        }
    });
    const firstShape = (shapes[0] as T | null) ?? undefined;
    return { validShapes, firstShape, skipped, isEmpty: false };
}
