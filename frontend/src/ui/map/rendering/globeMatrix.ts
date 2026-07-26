import * as THREE from 'three';

/**
 * Globe (vertical perspective) model-matrix math for the THREE.js custom
 * layers.
 *
 * maplibre-gl v5 exposed this as the internal
 * `map.transform.getMatrixForModel()`; v6 removed it and instead documents
 * the equivalent userland construction in the "Add a 3D model to globe"
 * example. This is that construction, matching v5's implementation
 * operation-for-operation (rotateY(lng) · rotateX(-lat) ·
 * translate(0, 0, 1 + alt/R) · rotateX(π/2) · scale(1/R)), so consumers'
 * existing frame corrections (heading negation, lateral mirror fix) remain
 * valid.
 */

/** Mean earth radius in meters, matching MapLibre's internal value. */
export const EARTH_RADIUS_METERS = 6371008.8;

/**
 * Matrix placing a meters-scale, Y-up model on the unit-radius globe at the
 * given position. Multiply with `defaultProjectionData.mainMatrix` from the
 * custom layer render args to project to clip space. Note the resulting
 * frame is mirror-flipped (opposite handedness) relative to a corrected
 * mercator scene.
 */
export function getGlobeModelMatrix(
    lngLat: [number, number],
    altitudeMeters: number
): THREE.Matrix4 {
    const [lng, lat] = lngLat;
    const scale = 1 / EARTH_RADIUS_METERS;
    return new THREE.Matrix4()
        .makeRotationY((lng / 180) * Math.PI)
        .multiply(new THREE.Matrix4().makeRotationX((-lat / 180) * Math.PI))
        .multiply(new THREE.Matrix4().makeTranslation(0, 0, 1 + altitudeMeters / EARTH_RADIUS_METERS))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
        .multiply(new THREE.Matrix4().makeScale(scale, scale, scale));
}
