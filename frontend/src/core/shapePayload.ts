/**
 * Pure helpers for normalizing 'poly' / 'polyline' socket payloads.
 *
 * The BlueSky proxy can deliver shape data in three formats:
 *   1. `{ polys: { name: shape, ... } }` - dictionary of shapes
 *   2. `shape`                           - a single shape
 *   3. `shape[]`                         - an array of shapes
 *
 * Both shape kinds share this envelope and the same lat/lon validation
 * rules, so SocketManager funnels both events through these helpers.
 * DOM-free so it can be unit tested in isolation.
 */

/** Minimal structural requirement for a shape payload entry. */
export interface ShapeLike {
    lat?: number[];
    lon?: number[];
}

export interface ShapePayloadResult<T extends ShapeLike> {
    /** Shapes that passed lat/lon validation, in payload order. */
    validShapes: T[];
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
 * shapes plus the labels of the entries that failed validation.
 */
export function parseShapePayload<T extends ShapeLike>(data: unknown): ShapePayloadResult<T> {
    let entries: Array<[string, unknown]>;

    if (data && typeof data === 'object' && 'polys' in data) {
        const dict = (data as { polys: unknown }).polys;
        if (!dict || typeof dict !== 'object' || Object.keys(dict).length === 0) {
            return { validShapes: [], skipped: [], isEmpty: true };
        }
        entries = Object.entries(dict);
    } else {
        // Legacy format: single shape or array of shapes
        const shapes = Array.isArray(data) ? data : [data];
        entries = shapes.map((shape, index) => [`#${index}`, shape]);
    }

    const validShapes: T[] = [];
    const skipped: string[] = [];
    for (const [label, shape] of entries) {
        if (hasValidLatLon(shape)) {
            validShapes.push(shape as T);
        } else {
            skipped.push(label);
        }
    }
    return { validShapes, skipped, isEmpty: false };
}
