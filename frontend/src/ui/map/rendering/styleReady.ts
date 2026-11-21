import type { Map as MapLibreMap } from 'maplibre-gl';

/**
 * True once the map's style document is parsed, which is all `map.addLayer()`
 * needs.
 *
 * Deliberately not `map.isStyleLoaded()`: that also waits for every source to
 * finish loading, and each aircraft data tick puts the GeoJSON traffic sources
 * back into "loading" for a moment. With traffic streaming on a slow renderer
 * (a few frames per second) a per-frame poll of `isStyleLoaded()` can keep
 * missing the brief loaded window, so a layer waiting on it attaches late or
 * never. `getStyle()` returns undefined exactly while the style document
 * itself is still loading.
 */
export function isStyleReady(map: MapLibreMap): boolean {
    return !!map.getStyle();
}

/**
 * Run `callback` once the map style is ready for `addLayer` (polled per
 * animation frame, since `style.load` may already have fired).
 *
 * @param map - Map whose style to wait for.
 * @param isCurrent - Checked before every poll; return false to abandon the
 *   wait (owner destroyed, or moved to another map).
 * @param callback - Invoked once, on the first frame the style is ready.
 */
export function whenStyleReady(
    map: MapLibreMap,
    isCurrent: () => boolean,
    callback: () => void
): void {
    const poll = () => {
        if (!isCurrent()) return;
        if (isStyleReady(map)) {
            callback();
        } else {
            requestAnimationFrame(poll);
        }
    };
    poll();
}
