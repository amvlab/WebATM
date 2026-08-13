import * as THREE from 'three';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { altitudeScaledForOrigin, mercatorCameraMatrix, relativePositionMeters } from '../rendering/mercatorUtils';
import type { LngLatPoint } from '../rendering/mercatorUtils';
import { isValidCoordinate } from '../../../utils/maplibre';
import { getGlobeModelMatrix } from '../rendering/globeMatrix';
import type { Render3DArgs } from '../rendering/CustomLayer3D';
import type { AircraftData, DisplayOptions } from '../../../data/types';
import type { StateManager } from '../../../core/StateManager';
import { logger } from '../../../utils/Logger';

// Base scale factor folded into every mesh scale alongside the model's
// real-world scale and the user's aircraft3DScale multiplier.
const BASE_SCALE_FACTOR = 10;

/**
 * Simplified aircraft data for 3D rendering
 */
export interface AircraftMeshData {
    lat: number;
    lon: number;
    alt: number;
    hdg: number;
    selected: boolean;
    inconf: boolean;
    actype: string;
}

/**
 * Everything the transform math needs from the owning custom layer.
 * Map and camera are fetched through getters because they only exist
 * once MapLibre has called the layer's onAdd.
 */
export interface Aircraft3DTransformsDeps {
    getMap: () => MapLibreMap | null;
    getCamera: () => THREE.Camera;
    getDisplayOptions: () => DisplayOptions;
    /**
     * Mercator fallback matrix builder (CustomLayer3D.createTransformMatrix):
     * (lng, lat, altitude, headingRad, pitchRad, rollRad, scale).
     */
    createFallbackMatrix: (
        lng: number,
        lat: number,
        altitude: number,
        heading: number,
        pitch: number,
        roll: number,
        scale: number
    ) => THREE.Matrix4;
    /** Source of per-aircraft scale overrides; null in tests. */
    stateManager: StateManager | null;
}

/**
 * Aircraft3DTransforms - scene-origin management and mesh/camera transform
 * math for the 3D aircraft layer, extracted from Aircraft3DCustomLayer.
 *
 * Owns the moving scene origin (mercator mode positions meshes in meters
 * relative to it), the globe origin rebasing that keeps mesh translations
 * small enough for float32, and the per-frame camera projection updates
 * for both projection modes.
 */
export class Aircraft3DTransforms {
    // Scene origin for relative positioning (mercator mode)
    private sceneOrigin: { lng: number; lat: number } | null = null;
    // Max distance in meters an aircraft may drift from the origin before it is repositioned
    private readonly maxDistanceFromOrigin = 10000;

    // Inverse of the globe origin matrix for the current frame. Globe mesh
    // matrices are rebased with this so their translations stay small enough
    // for GPU float32; see applyGlobeCamera for the full story.
    private globeOriginMatrixInverse: THREE.Matrix4 | null = null;

    constructor(private readonly deps: Aircraft3DTransformsDeps) {}

    /**
     * Initialize or update scene origin based on aircraft positions.
     * Returns true when the origin was repositioned, in which case the
     * caller must re-apply mercator transforms to existing meshes.
     *
     * Invalid records (NaN or out-of-range lat/lon — BlueSky delivers
     * these, e.g. after a MOVE beyond lat 90) are ignored, mirroring the
     * per-aircraft guard in the renderers. A poisoned origin would make
     * MercatorCoordinate.fromLngLat throw on every mesh and camera update.
     */
    updateSceneOrigin(aircraftData: AircraftData): boolean {
        const valid: LngLatPoint[] = [];
        for (let i = 0; i < aircraftData.lat.length; i++) {
            if (isValidCoordinate(aircraftData.lat[i], aircraftData.lon[i])) {
                valid.push({ lng: aircraftData.lon[i], lat: aircraftData.lat[i] });
            }
        }

        if (!this.sceneOrigin) {
            if (valid.length > 0) {
                this.sceneOrigin = { ...valid[0] };
            } else {
                // Fallback to map center if available
                const center = this.deps.getMap()?.getCenter();
                if (!center) return false;
                this.sceneOrigin = { lng: center.lng, lat: center.lat };
            }
            logger.debug('Aircraft3DTransforms', `Scene origin set to: ${this.sceneOrigin.lng.toFixed(6)}, ${this.sceneOrigin.lat.toFixed(6)}`);
        }

        const origin = this.sceneOrigin;
        const needsRepositioning = valid.some((p) =>
            this.calculateDistance(origin.lat, origin.lng, p.lat, p.lng) > this.maxDistanceFromOrigin
        );

        return needsRepositioning ? this.repositionSceneOrigin(valid) : false;
    }

    /**
     * Reposition scene origin to the centroid of the given (valid) aircraft
     * positions. Returns true when the origin actually moved (changes under
     * 10 m are skipped).
     */
    private repositionSceneOrigin(coords: LngLatPoint[]): boolean {
        if (coords.length === 0) return false;

        let sumLat = 0;
        let sumLng = 0;
        for (const c of coords) {
            sumLat += c.lat;
            sumLng += c.lng;
        }
        const newOrigin = {
            lng: sumLng / coords.length,
            lat: sumLat / coords.length
        };

        const distanceToNewOrigin = this.calculateDistance(
            this.sceneOrigin!.lat, this.sceneOrigin!.lng,
            newOrigin.lat, newOrigin.lng
        );
        if (distanceToNewOrigin < 10) {
            return false;
        }

        logger.debug('Aircraft3DTransforms', `Repositioning scene origin from ${this.sceneOrigin!.lng.toFixed(6)}, ${this.sceneOrigin!.lat.toFixed(6)} to ${newOrigin.lng.toFixed(6)}, ${newOrigin.lat.toFixed(6)}`);

        this.sceneOrigin = newOrigin;
        return true;
    }

    /**
     * Calculate distance between two points in meters
     */
    private calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
        const R = 6371000; // Earth's radius in meters
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLng/2) * Math.sin(dLng/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    }

    /**
     * Calculate relative position from scene origin in meters
     */
    private calculateRelativePosition(lat: number, lng: number): { east: number; north: number } {
        if (!this.sceneOrigin) {
            return { east: 0, north: 0 };
        }
        return relativePositionMeters(this.sceneOrigin, { lng, lat });
    }

    /**
     * Pre-scale altitude so the 3D aircraft layer (origin: centroid of all
     * aircraft) and the 3D route layer (origin: selected aircraft) agree on
     * visual height. See altitudeScaledForOrigin.
     */
    private altitudeForOrigin(altMeters: number, lat: number, lon: number): number {
        if (!this.sceneOrigin) return altMeters;
        return altitudeScaledForOrigin(altMeters, { lng: lon, lat }, this.sceneOrigin);
    }

    /**
     * Read the per-mesh real-world scale stamped at creation time.
     * Falls back to 1 for meshes that predate this logic.
     */
    private getMeshRealScale(mesh: THREE.Object3D): number {
        const s = (mesh.userData as { realScale?: number })?.realScale;
        return typeof s === 'number' && s > 0 ? s : 1;
    }

    /**
     * Resolve the user-visible scale multiplier for a mesh: its
     * per-aircraft override if set, otherwise the global setting.
     */
    private getUserScaleMultiplier(mesh: THREE.Object3D): number {
        const id = (mesh.userData as { aircraftId?: string })?.aircraftId;
        if (id && this.deps.stateManager) {
            const override = this.deps.stateManager.getAircraftScaleOverride(id);
            if (override !== null && override > 0) return override;
        }
        return this.deps.getDisplayOptions().aircraft3DScale || 2.0;
    }

    /**
     * Shared transform inputs used by all three transform variants:
     * altitude, heading in radians, and the combined scale factor
     * (real-world base × user multiplier × global base scale).
     */
    private computeMeshTransformBasics(mesh: THREE.Object3D, data: AircraftMeshData): {
        altitudeMeters: number;
        headingRad: number;
        finalScale: number;
    } {
        // Altitude already in meters from BlueSky
        const altitudeMeters = data.alt;
        const headingRad = THREE.MathUtils.degToRad(data.hdg);
        const realScale = this.getMeshRealScale(mesh);
        const userMultiplier = this.getUserScaleMultiplier(mesh);
        const finalScale = realScale * userMultiplier * BASE_SCALE_FACTOR;
        return { altitudeMeters, headingRad, finalScale };
    }

    /**
     * Disable frustum culling on the whole mesh hierarchy so distant or
     * high-altitude aircraft don't pop out of view at steep zoom levels.
     */
    private disableFrustumCulling(mesh: THREE.Object3D): void {
        mesh.frustumCulled = false;
        mesh.traverse((child) => {
            child.frustumCulled = false;
        });
    }

    /**
     * Update mesh position, rotation, and scale using relative positioning
     * Used when scene-based transform is active (mercator mode)
     */
    updateMeshTransform(mesh: THREE.Object3D, data: AircraftMeshData): void {
        const relativePos = this.calculateRelativePosition(data.lat, data.lon);
        const { headingRad, finalScale } = this.computeMeshTransformBasics(mesh, data);

        // Altitude in meters from BlueSky, lat-corrected so the world Z
        // matches the route renderer (which has a different scene origin).
        const altitudeMeters = this.altitudeForOrigin(data.alt, data.lat, data.lon);

        // Scene frame: x=east, y=up, z=north, in meters from the scene origin
        mesh.position.set(relativePos.east, altitudeMeters, relativePos.north);

        // Heading is a Y (vertical-axis) rotation: aviation 0°=N maps to
        // three.js +Z, minus π/2 for the model's default orientation.
        mesh.rotation.set(0, headingRad - Math.PI / 2, 0);

        // Set scale
        mesh.scale.set(finalScale, finalScale, finalScale);

        this.disableFrustumCulling(mesh);

        // Enable automatic matrix updates for this positioning approach
        mesh.matrixAutoUpdate = true;
    }

    /**
     * Update mesh for globe projection using individual projection-aware transforms
     */
    updateMeshTransformForGlobe(mesh: THREE.Object3D, data: AircraftMeshData): void {
        try {
            const { altitudeMeters, headingRad, finalScale } = this.computeMeshTransformBasics(mesh, data);

            // Place the model on the globe ([lng, lat] order) and fold in the
            // combined scale.
            const l = getGlobeModelMatrix([data.lon, data.lat], altitudeMeters)
                .scale(new THREE.Vector3(finalScale, finalScale, finalScale));

            // The globe model frame is mirror-flipped (opposite handedness)
            // vs the corrected mercator group, so negate the heading to keep
            // the nose on the right compass bearing (0°=N, 90°=E). The
            // geometry flip is undone just below.
            const rotationY = new THREE.Matrix4().makeRotationY(-headingRad + Math.PI / 2);
            l.multiply(rotationY);

            // Reflect the model's lateral (Z) axis back so on-fuselage text
            // and liveries don't render mirrored in globe view. Nose (+X)
            // and up (+Y) are untouched, so heading and attitude are kept.
            const lateralMirrorFix = new THREE.Matrix4().makeScale(1, 1, -1);
            l.multiply(lateralMirrorFix);

            // Rebase onto the globe origin so the mesh matrix keeps small
            // translations (precision; see globeOriginMatrixInverse). The
            // origin matrix is reapplied via the camera projection, so the
            // product is mathematically unchanged. When the inverse isn't
            // available yet (first globe frame), the absolute matrix pairs
            // with the mainMatrix-only camera fallback in applyGlobeCamera.
            if (this.globeOriginMatrixInverse) {
                l.premultiply(this.globeOriginMatrixInverse);
            }

            // Set the transform - the camera projection matrix is set per
            // frame in applyGlobeCamera
            mesh.matrix = l;
            mesh.matrixAutoUpdate = false;

            this.disableFrustumCulling(mesh);
        } catch (error) {
            logger.error('Aircraft3DTransforms', `[GLOBE] Error in updateMeshTransformForGlobe: ${error}`);
            // Fallback to mercator transform if anything fails
            this.updateMeshTransformForMercator(mesh, data);
        }
    }

    /**
     * Update mesh for mercator projection using individual transforms
     * Used as fallback when the globe transform math fails
     */
    private updateMeshTransformForMercator(mesh: THREE.Object3D, data: AircraftMeshData): void {
        const { altitudeMeters, headingRad, finalScale } = this.computeMeshTransformBasics(mesh, data);

        // Same heading convention as updateMeshTransform, folded into an
        // absolute mercator matrix instead of scene-relative position.
        const transformMatrix = this.deps.createFallbackMatrix(
            data.lon,
            data.lat,
            altitudeMeters,
            headingRad - Math.PI / 2,
            0, // pitch
            0, // roll
            finalScale
        );

        // Apply the transform matrix directly
        mesh.matrix = transformMatrix;
        mesh.matrixAutoUpdate = false; // We're manually setting the matrix

        this.disableFrustumCulling(mesh);
    }

    /**
     * Per-frame camera projection for globe mode. Each aircraft mesh gets an
     * origin-relative globe model transform, and the shared origin matrix is
     * folded into the camera projection here. Both factors are combined on
     * the CPU in double precision, so the GPU only ever sees small mesh
     * translations — this is what keeps small aircraft from collapsing into
     * stringy float32 artifacts.
     */
    applyGlobeCamera(args: Render3DArgs): void {
        const mainMatrix = new THREE.Matrix4().fromArray(
            args.defaultProjectionData.mainMatrix
        );

        // Anchor at the scene origin (aircraft centroid); fall back to the
        // map center before any aircraft exist.
        const origin = this.sceneOrigin ?? this.deps.getMap()?.getCenter();
        if (origin) {
            const originMatrix = getGlobeModelMatrix([origin.lng, origin.lat], 0);
            this.globeOriginMatrixInverse = originMatrix.clone().invert();
            this.deps.getCamera().projectionMatrix = mainMatrix.multiply(originMatrix);
        } else {
            // No origin to anchor on yet (no aircraft and no map): meshes
            // keep absolute matrices, so use mainMatrix alone.
            this.globeOriginMatrixInverse = null;
            this.deps.getCamera().projectionMatrix = mainMatrix;
        }
    }

    /**
     * Per-frame camera projection for mercator mode. Returns false when no
     * scene origin exists yet (nothing to project against).
     */
    applyMercatorCamera(args: Render3DArgs): boolean {
        if (!this.sceneOrigin) return false;
        this.deps.getCamera().projectionMatrix = mercatorCameraMatrix(
            args.defaultProjectionData.mainMatrix,
            this.sceneOrigin
        );
        return true;
    }
}
