import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { altitudeScaledForOrigin, relativePositionMeters } from '../rendering/mercatorUtils';
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
    private sceneOrigin: { lng: number; lat: number } | null = null; // Scene origin for relative positioning
    private sceneOriginElevation: number = 0; // Scene origin elevation in meters
    private maxDistanceFromOrigin: number = 10000; // Max distance in meters before repositioning origin

    // Inverse of the globe origin matrix for the current frame. Globe mesh
    // matrices are made origin-relative with this so their translations stay
    // small; the origin matrix itself is folded into the camera projection in
    // applyGlobeCamera (computed on the CPU in double precision). Without this,
    // getMatrixForModel's huge absolute translations dwarf the tiny model
    // scale and float32 rounding on the GPU quantizes vertices to ~meter
    // steps, crumpling small aircraft into stretched "stringy" triangles.
    private globeOriginMatrixInverse: THREE.Matrix4 | null = null;

    constructor(private readonly deps: Aircraft3DTransformsDeps) {}

    /**
     * Initialize or update scene origin based on aircraft positions.
     * Returns true when the origin was repositioned, in which case the
     * caller must re-apply mercator transforms to existing meshes.
     */
    updateSceneOrigin(aircraftData: AircraftData): boolean {
        if (!this.sceneOrigin) {
            // Initialize scene origin with first aircraft or map center
            if (aircraftData.lat.length > 0) {
                this.sceneOrigin = {
                    lng: aircraftData.lon[0],
                    lat: aircraftData.lat[0]
                };
            } else {
                // Fallback to map center if available
                const center = this.deps.getMap()?.getCenter();
                if (!center) return false;
                this.sceneOrigin = {
                    lng: center.lng,
                    lat: center.lat
                };
            }
            logger.debug('Aircraft3DTransforms', `Scene origin set to: ${this.sceneOrigin.lng.toFixed(6)}, ${this.sceneOrigin.lat.toFixed(6)}`);
        }

        // Check if any aircraft is too far from current origin
        let needsRepositioning = false;
        for (let i = 0; i < aircraftData.lat.length; i++) {
            const distance = this.calculateDistance(
                this.sceneOrigin.lat, this.sceneOrigin.lng,
                aircraftData.lat[i], aircraftData.lon[i]
            );
            if (distance > this.maxDistanceFromOrigin) {
                needsRepositioning = true;
                break;
            }
        }

        if (needsRepositioning) {
            return this.repositionSceneOrigin(aircraftData);
        }
        return false;
    }

    /**
     * Reposition scene origin to aircraft centroid. Returns true when the
     * origin actually moved (changes under 10 m are skipped).
     */
    private repositionSceneOrigin(aircraftData: AircraftData): boolean {
        if (aircraftData.lat.length === 0) return false;

        // Calculate centroid of all aircraft
        let sumLat = 0;
        let sumLng = 0;
        for (let i = 0; i < aircraftData.lat.length; i++) {
            sumLat += aircraftData.lat[i];
            sumLng += aircraftData.lon[i];
        }

        const newOrigin = {
            lng: sumLng / aircraftData.lon.length,
            lat: sumLat / aircraftData.lat.length
        };

        // Check if the new origin is significantly different from current origin
        // Only reposition if difference is meaningful (> 10 meters)
        const distanceToNewOrigin = this.calculateDistance(
            this.sceneOrigin!.lat, this.sceneOrigin!.lng,
            newOrigin.lat, newOrigin.lng
        );

        if (distanceToNewOrigin < 10) {
            // Origin change is too small to be meaningful, skip repositioning
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
        // Calculate position relative to scene origin in meters
        const relativePos = this.calculateRelativePosition(data.lat, data.lon);

        const { headingRad, finalScale } = this.computeMeshTransformBasics(mesh, data);

        // Altitude in meters from BlueSky, lat-corrected so the world Z
        // matches the route renderer (which has a different scene origin).
        const altitudeMeters = this.altitudeForOrigin(data.alt, data.lat, data.lon);

        // Set position in meter coordinates relative to scene origin
        // Scene coordinate system: (x=east, y=up, z=north)
        mesh.position.set(
            relativePos.east,         // x = east offset in meters
            altitudeMeters,          // y = up (altitude) in meters
            relativePos.north        // z = north offset in meters
        );

        // Set rotation for aircraft heading
        // In our scene coordinate system (x=east, y=up, z=north):
        // - Y-axis rotation controls heading (rotation around vertical axis)
        // - 0° heading = north = positive Z direction
        // - Aviation convention: 0°=N, 90°=E, 180°=S, 270°=W
        // - Three.js Y-rotation: 0=+Z(north), π/2=+X(east), π=-Z(south), 3π/2=-X(west)
        // - Model correction: subtract π/2 to account for model's default orientation
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

            // Check if getMatrixForModel is available (for globe projection)
            const map = this.deps.getMap();
            if (map?.transform?.getMatrixForModel) {
                // Based on MapLibre globe examples, getMatrixForModel expects [lng, lat] order
                const modelMatrix = map.transform.getMatrixForModel([data.lon, data.lat], altitudeMeters);

                const l = new THREE.Matrix4().fromArray(modelMatrix)
                    .scale(new THREE.Vector3(finalScale, finalScale, finalScale));

                // Apply heading rotation - in globe space.
                // Aviation convention: 0°=N, 90°=E, 180°=S, 270°=W.
                // getMatrixForModel's frame is mirror-flipped (opposite
                // handedness) relative to the corrected mercator group frame,
                // so the heading angle is negated here to keep the nose pointing
                // the correct compass direction (this is undone for geometry by
                // the lateral mirror correction below).
                const rotationY = new THREE.Matrix4().makeRotationY(-headingRad + Math.PI / 2);
                l.multiply(rotationY);

                // Un-mirror the model. Because the globe frame reflects the
                // model's lateral axis versus the (text-corrected) mercator
                // path, on-fuselage text and liveries would otherwise render
                // reversed in globe view — the model appears flipped. Reflect
                // the model's lateral (Z) axis back so geometry matches
                // mercator. The model's nose (+X) and up (+Y) axes are
                // untouched, so heading and attitude are unchanged; only the
                // handedness/chirality flips, fixing the mirrored appearance.
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
            } else {
                logger.warn('Aircraft3DTransforms', '[GLOBE] getMatrixForModel not available, falling back to mercator transform');
                // Fallback to mercator-style transform if globe API not available
                this.updateMeshTransformForMercator(mesh, data);
                return;
            }

            this.disableFrustumCulling(mesh);
        } catch (error) {
            logger.error('Aircraft3DTransforms', `[GLOBE] Error in updateMeshTransformForGlobe: ${error}`);
            // Fallback to mercator transform if anything fails
            this.updateMeshTransformForMercator(mesh, data);
        }
    }

    /**
     * Update mesh for mercator projection using individual transforms
     * Used as fallback when the globe model API is unavailable
     */
    private updateMeshTransformForMercator(mesh: THREE.Object3D, data: AircraftMeshData): void {
        const { altitudeMeters, headingRad, finalScale } = this.computeMeshTransformBasics(mesh, data);

        // Use traditional transform matrix for mercator
        // Aviation convention: 0°=N, 90°=E, 180°=S, 270°=W
        // Three.js Y-rotation: 0=+Z(north), π/2=+X(east), π=-Z(south), 3π/2=-X(west)
        // Model correction: subtract π/2 to account for model's default orientation
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
     * origin-relative getMatrixForModel transform, and the shared origin
     * matrix is folded into the camera projection here. Both factors are
     * combined on the CPU in double precision, so the GPU only ever sees
     * small mesh translations — this is what keeps small aircraft from
     * collapsing into stringy float32 artifacts.
     */
    applyGlobeCamera(args: Render3DArgs): void {
        const mainMatrix = new THREE.Matrix4().fromArray(
            args.defaultProjectionData.mainMatrix
        );

        const map = this.deps.getMap();
        if (map?.transform?.getMatrixForModel) {
            // Anchor at the scene origin (aircraft centroid); fall
            // back to the map center before any aircraft exist.
            const origin = this.sceneOrigin ?? map.getCenter();
            const originMatrix = new THREE.Matrix4().fromArray(
                map.transform.getMatrixForModel([origin.lng, origin.lat], 0)
            );
            this.globeOriginMatrixInverse = originMatrix.clone().invert();
            this.deps.getCamera().projectionMatrix = mainMatrix.multiply(originMatrix);
        } else {
            // No globe model API: meshes fall back to absolute
            // mercator-style matrices, so use mainMatrix alone.
            this.globeOriginMatrixInverse = null;
            this.deps.getCamera().projectionMatrix = mainMatrix;
        }
    }

    /**
     * Per-frame camera projection for mercator mode: mainMatrix × scene
     * origin translation × meters-to-mercator scale. Returns false when no
     * scene origin exists yet (nothing to project against).
     */
    applyMercatorCamera(args: Render3DArgs): boolean {
        if (!this.sceneOrigin) return false;

        const sceneOriginMercator = MercatorCoordinate.fromLngLat(
            [this.sceneOrigin.lng, this.sceneOrigin.lat],
            this.sceneOriginElevation
        );

        // Apply transform: mainMatrix * translation * scale.
        // The mercatorGroup's rotateX(π/2) already flips scene-north into
        // mercator-south, so we use a pure positive scale here (no Y mirror).
        // Keeping all scales positive avoids mirroring the texture content
        // of aircraft models (which would otherwise render text reversed).
        const scale = sceneOriginMercator.meterInMercatorCoordinateUnits();
        const m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix);
        const l = new THREE.Matrix4()
            .makeTranslation(sceneOriginMercator.x, sceneOriginMercator.y, sceneOriginMercator.z)
            .scale(new THREE.Vector3(scale, scale, scale));

        this.deps.getCamera().projectionMatrix = m.multiply(l);
        return true;
    }
}
