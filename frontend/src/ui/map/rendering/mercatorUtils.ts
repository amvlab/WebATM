import { MercatorCoordinate } from 'maplibre-gl';

/**
 * Shared web-mercator math for the THREE.js custom layers. The 3D aircraft
 * and 3D route layers each position their meshes in a local meters-from-
 * scene-origin frame; both used to carry private copies of these
 * conversions.
 */

export interface LngLatPoint {
    lng: number;
    lat: number;
}

/**
 * East/north offset in meters from origin to target, using the mercator
 * meter scale at the origin (consistent with a scene whose camera
 * transform is scaled by meterInMercatorCoordinateUnits at the origin).
 */
export function relativePositionMeters(
    origin: LngLatPoint,
    target: LngLatPoint
): { east: number; north: number } {
    const originMercator = MercatorCoordinate.fromLngLat([origin.lng, origin.lat]);
    const targetMercator = MercatorCoordinate.fromLngLat([target.lng, target.lat]);

    const mercatorPerMeter = originMercator.meterInMercatorCoordinateUnits();
    return {
        east: (targetMercator.x - originMercator.x) / mercatorPerMeter,
        // Mercator y grows southward; scene north is positive.
        north: (originMercator.y - targetMercator.y) / mercatorPerMeter,
    };
}

/**
 * Pre-scale an altitude so that, after the camera projection multiplies
 * scene Y by `meterInMercatorCoordinateUnits` at the SCENE ORIGIN's lat,
 * the resulting world Z equals altitude x per-point mercator scale. This
 * makes altitude rendering independent of which scene origin a layer
 * happens to use, so layers with different origins agree on visual height.
 */
export function altitudeScaledForOrigin(
    altMeters: number,
    point: LngLatPoint,
    origin: LngLatPoint
): number {
    const pointMpm = MercatorCoordinate.fromLngLat([point.lng, point.lat]).meterInMercatorCoordinateUnits();
    const originMpm = MercatorCoordinate.fromLngLat([origin.lng, origin.lat]).meterInMercatorCoordinateUnits();
    return altMeters * (pointMpm / originMpm);
}
