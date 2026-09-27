import * as THREE from 'three';
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
    // Wrap the east offset to the nearest world copy (world width = 1 in
    // mercator units) so a target just across the antimeridian is meters
    // away, not a full world width.
    let dx = targetMercator.x - originMercator.x;
    dx -= Math.round(dx);
    return {
        east: dx / mercatorPerMeter,
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

/**
 * Camera projection matrix for a scene positioned in meters relative to
 * `origin`: mainMatrix x translate(origin in mercator) x uniform meter scale.
 *
 * Expects the scene group to map its local (east, up, north) frame into
 * mercator axes with a plain rotateX(PI/2) and no mirror — keeping every
 * scale positive avoids flipping texture content (e.g. fuselage text).
 *
 * When `viewCenterLng` is given, the scene is anchored in the world copy
 * nearest that longitude: with the view just across the antimeridian from
 * the origin, the unshifted anchor would be a full world width off screen.
 */
export function mercatorCameraMatrix(
    mainMatrix: ArrayLike<number>,
    origin: LngLatPoint,
    viewCenterLng?: number
): THREE.Matrix4 {
    const originMercator = MercatorCoordinate.fromLngLat([origin.lng, origin.lat]);
    let originX = originMercator.x;
    if (viewCenterLng !== undefined) {
        const centerX = MercatorCoordinate.fromLngLat([viewCenterLng, 0]).x;
        originX += Math.round(centerX - originX);
    }
    const scale = originMercator.meterInMercatorCoordinateUnits();
    const local = new THREE.Matrix4()
        .makeTranslation(originX, originMercator.y, originMercator.z)
        .scale(new THREE.Vector3(scale, scale, scale));
    return new THREE.Matrix4().fromArray(mainMatrix).multiply(local);
}
