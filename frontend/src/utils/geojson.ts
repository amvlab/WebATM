/**
 * Small typed builders for the GeoJSON features the map renderers and
 * drawing managers construct inline all over the codebase. Coordinates
 * follow the GeoJSON convention: [lng, lat].
 */

export type LngLat = [number, number];

export function pointFeature(
    coordinates: LngLat,
    properties: GeoJSON.GeoJsonProperties = {},
    id?: string | number
): GeoJSON.Feature<GeoJSON.Point> {
    return {
        type: 'Feature',
        ...(id !== undefined && { id }),
        geometry: { type: 'Point', coordinates },
        properties,
    };
}

export function lineStringFeature(
    coordinates: LngLat[],
    properties: GeoJSON.GeoJsonProperties = {}
): GeoJSON.Feature<GeoJSON.LineString> {
    return {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties,
    };
}

/**
 * Build a polygon feature from a single outer ring. The ring is closed
 * automatically (first point appended) unless it already is.
 */
export function polygonFeature(
    ring: LngLat[],
    properties: GeoJSON.GeoJsonProperties = {}
): GeoJSON.Feature<GeoJSON.Polygon> {
    const closed = ring.length > 0 && !isClosed(ring) ? [...ring, ring[0]] : ring;
    return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [closed] },
        properties,
    };
}

export function featureCollection<G extends GeoJSON.Geometry>(
    features: Array<GeoJSON.Feature<G>> = []
): GeoJSON.FeatureCollection<G> {
    return { type: 'FeatureCollection', features };
}

/** Convert {lat, lng} points (drawing managers' format) to [lng, lat]. */
export function toLngLatCoords(points: Array<{ lat: number; lng: number }>): LngLat[] {
    return points.map(p => [p.lng, p.lat]);
}

function isClosed(ring: LngLat[]): boolean {
    if (ring.length < 2) return false;
    const [firstLng, firstLat] = ring[0];
    const [lastLng, lastLat] = ring[ring.length - 1];
    return firstLng === lastLng && firstLat === lastLat;
}
