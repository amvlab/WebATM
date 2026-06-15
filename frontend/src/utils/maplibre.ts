import {
    Map as MapLibreMap,
    GeoJSONSource,
    LayerSpecification,
    SourceSpecification,
    ExpressionSpecification
} from 'maplibre-gl';

const EMPTY_FEATURE_COLLECTION: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: []
};

/**
 * Canvas cursor used by every interactive map-drawing mode (console map
 * picker, shape/route drawing, aircraft creation). Centralised here so all
 * drawing modes share one consistent pointer. Assign the empty string to
 * restore MapLibre's default cursor when leaving a drawing mode.
 */
export const DRAWING_CURSOR = 'crosshair';

export function ensureGeoJSONSource(
    map: MapLibreMap,
    sourceId: string,
    extra?: Omit<SourceSpecification & { type: 'geojson' }, 'type' | 'data'>
): void {
    if (map.getSource(sourceId)) return;
    map.addSource(sourceId, {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
        ...(extra ?? {})
    } as SourceSpecification);
}

export function ensureLayer(
    map: MapLibreMap,
    spec: LayerSpecification,
    beforeId?: string
): void {
    if (map.getLayer(spec.id)) return;
    map.addLayer(spec, beforeId);
}

export function updateSourceFeatures(
    map: MapLibreMap,
    sourceId: string,
    features: GeoJSON.Feature<GeoJSON.Geometry>[]
): void {
    const source = map.getSource(sourceId) as GeoJSONSource | undefined;
    if (!source) return;
    source.setData({ type: 'FeatureCollection', features });
}

export function setLayerVisibility(
    map: MapLibreMap,
    layerId: string,
    visible: boolean
): void {
    if (!map.getLayer(layerId)) return;
    map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
}

/**
 * Remove a layer if it exists. No-op when missing.
 */
export function safeRemoveLayer(map: MapLibreMap, layerId: string): void {
    if (map.getLayer(layerId)) {
        map.removeLayer(layerId);
    }
}

/**
 * Remove a source if it exists. No-op when missing.
 */
export function safeRemoveSource(map: MapLibreMap, sourceId: string): void {
    if (map.getSource(sourceId)) {
        map.removeSource(sourceId);
    }
}

/**
 * Build a MapLibre expression of the form:
 *   ['case', ['==', ['get','selected'], true], selected,
 *            ['==', ['get','in_conflict'], true], conflict,
 *            normal]
 * `conflict` is optional; when omitted the conflict clause is skipped.
 */
export function buildConditionalColorExpr(
    normal: string,
    selected: string,
    conflict?: string
): ExpressionSpecification {
    const expr: unknown[] = ['case', ['==', ['get', 'selected'], true], selected];
    if (conflict) {
        expr.push(['==', ['get', 'in_conflict'], true], conflict);
    }
    expr.push(normal);
    // Built dynamically, so assert the final shape once here instead of
    // casting at every call site.
    return expr as ExpressionSpecification;
}

/**
 * Same shape as buildConditionalColorExpr but meant for image / sprite lookups.
 * Kept as a separate function for readability at call sites.
 */
export function buildConditionalImageExpr(
    normal: string,
    selected: string,
    conflict?: string
): ExpressionSpecification {
    return buildConditionalColorExpr(normal, selected, conflict);
}

export function isValidCoordinate(lat: unknown, lon: unknown): boolean {
    return (
        typeof lat === 'number' &&
        typeof lon === 'number' &&
        !Number.isNaN(lat) &&
        !Number.isNaN(lon) &&
        lat >= -90 &&
        lat <= 90 &&
        lon >= -180 &&
        lon <= 180
    );
}
