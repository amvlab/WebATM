import * as THREE from 'three';
import { CustomLayer3D } from '../rendering/CustomLayer3D';
import type { Render3DArgs } from '../rendering/CustomLayer3D';
import type { AircraftData, DisplayOptions } from '../../../data/types';
import type { StateManager } from '../../../core/StateManager';
import {
    DEFAULT_FALLBACK_MODEL,
    MODEL_DIR,
    resolveAircraftModelPath,
} from '../../../data/aircraftCategories';
import { logger } from '../../../utils/Logger';
import { isValidCoordinate } from '../../../utils/maplibre';
import { Aircraft3DModelLoader } from './Aircraft3DModelLoader';
import { Aircraft3DTransforms } from './Aircraft3DTransforms';
import type { AircraftMeshData } from './Aircraft3DTransforms';
import { Aircraft3DFleet } from './Aircraft3DFleet';

/**
 * Custom MapLibre layer for 3D aircraft rendering.
 *
 * Coordinates the scene (projection-specific mesh groups, lighting,
 * per-frame camera updates) and translates aircraft data ticks into
 * fleet operations. Mesh CRUD lives in Aircraft3DFleet; scene-origin and
 * transform math in Aircraft3DTransforms; model loading/caching in
 * Aircraft3DModelLoader.
 */
export class Aircraft3DCustomLayer extends CustomLayer3D {
    private displayOptions: DisplayOptions;
    private modelLoader: Aircraft3DModelLoader;
    private transforms: Aircraft3DTransforms;
    private fleet: Aircraft3DFleet;
    // Default/fallback model path — used when aircraft type is unknown or missing.
    private modelPath: string = `${MODEL_DIR}${DEFAULT_FALLBACK_MODEL}`;
    private pendingAircraftData: AircraftData | null = null;
    private lastProjectionMode: boolean | null = null; // Track projection mode changes for debug logging

    // Separate groups for different projection modes
    // Globe mode: uses raw getMatrixForModel transforms (no scene rotation)
    // Mercator mode: uses scene-based coordinate system (with rotation)
    private mercatorGroup: THREE.Group | null = null;
    private globeGroup: THREE.Group | null = null;

    // Source of per-aircraft model overrides; null when renderer is
    // created without a StateManager (e.g. in tests).
    private stateManager: StateManager | null;

    constructor(displayOptions: DisplayOptions, stateManager: StateManager | null) {
        super('aircraft-3d-layer');
        this.displayOptions = displayOptions;
        this.stateManager = stateManager;
        this.modelLoader = new Aircraft3DModelLoader({
            getMaxAnisotropy: () => this.renderer?.capabilities?.getMaxAnisotropy?.() || 16,
            onModelLoaded: (path) => this.fleet.processPending(path)
        });
        this.transforms = new Aircraft3DTransforms({
            getMap: () => this.map ?? null,
            getCamera: () => this.camera,
            getDisplayOptions: () => this.displayOptions,
            createFallbackMatrix: (lng, lat, altitude, heading, pitch, roll, scale) =>
                this.createTransformMatrix(lng, lat, altitude, heading, pitch, roll, scale),
            stateManager,
        });
        this.fleet = new Aircraft3DFleet({
            modelLoader: this.modelLoader,
            transforms: this.transforms,
            getMercatorGroup: () => this.mercatorGroup,
            getGlobeGroup: () => this.globeGroup,
            isGlobeProjection: () => this.isGlobeProjection(),
        });
        this.updateModelPath();
    }

    protected onSceneReady(): void {
        logger.debug('Aircraft3DCustomLayer', '3D scene ready');

        // Create two separate groups for different projection modes
        // This allows us to handle coordinate systems differently for each mode

        // Mercator group: uses scene-based coordinate system with rotation only.
        // Coordinate system: (x=east, y=up, z=north).
        // A single rotateX(π/2) maps (east, up, north) → (east, -north, up), which,
        // paired with a positive-scaled projection below, lands in MapLibre mercator
        // coords (Y = south). No mirror/negative scales are used so text on the 3D
        // models (registration IDs, liveries, etc.) never renders reversed.
        this.mercatorGroup = new THREE.Group();
        this.mercatorGroup.rotateX(Math.PI / 2);
        this.scene.add(this.mercatorGroup);

        // Globe group: uses raw getMatrixForModel transforms (no scene rotation)
        // MapLibre's getMatrixForModel provides the correct transform for globe projection
        this.globeGroup = new THREE.Group();
        this.scene.add(this.globeGroup);

        // Preload the default fallback model. Per-type models are loaded
        // lazily as aircraft arrive with recognized ICAO codes.
        this.modelLoader.load(this.modelPath);

        // Process any pending aircraft data that arrived before scene was ready
        if (this.pendingAircraftData) {
            logger.debug('Aircraft3DCustomLayer', 'Processing aircraft data that arrived before scene was ready');
            this.updateAircraft(this.pendingAircraftData);
            this.pendingAircraftData = null;
        }
    }

    /**
     * Update aircraft with new data
     */
    updateAircraft(aircraftData: AircraftData): void {
        // Guard: If scene isn't ready yet, queue the aircraft data for later processing
        if (!this.scene) {
            logger.debug('Aircraft3DCustomLayer', 'Scene not ready yet, queuing aircraft data');
            this.pendingAircraftData = aircraftData;
            return;
        }

        if (!aircraftData.id || aircraftData.id.length === 0) {
            return;
        }

        // Initialize or update scene origin based on aircraft positions.
        // When it moves, existing mercator meshes must be re-positioned
        // relative to the new origin (globe uses absolute positioning).
        if (this.transforms.updateSceneOrigin(aircraftData) && !this.isGlobeProjection()) {
            this.fleet.forEach((aircraftMesh) => {
                this.transforms.updateMeshTransform(aircraftMesh.mesh, aircraftMesh.data);
            });
        }

        const activeIds = new Set<string>();
        const selectedModel = this.displayOptions.selectedAircraftModel;

        for (let i = 0; i < aircraftData.id.length; i++) {
            const id = aircraftData.id[i];

            // Skip aircraft with invalid coordinates: MercatorCoordinate.fromLngLat
            // throws on out-of-range values, which would crash the whole tick.
            const lat = aircraftData.lat[i];
            const lon = aircraftData.lon[i];
            if (!isValidCoordinate(lat, lon)) {
                continue;
            }

            activeIds.add(id);

            const actype = aircraftData.actype?.[i] ?? '';
            const override = this.stateManager?.getAircraftModelOverride(id) ?? null;
            const modelPath = resolveAircraftModelPath(selectedModel, actype, override);

            const data: AircraftMeshData = {
                lat: aircraftData.lat[i],
                lon: aircraftData.lon[i],
                alt: aircraftData.alt[i],
                hdg: aircraftData.trk[i],
                selected: false,
                inconf: aircraftData.inconf ? aircraftData.inconf[i] : false,
                actype,
            };

            const existing = this.fleet.get(id);
            if (!existing) {
                this.fleet.create(id, data, modelPath);
            } else if (existing.modelPath !== modelPath) {
                // Aircraft type (and therefore its model) changed — rebuild the mesh.
                this.fleet.remove(id);
                this.fleet.create(id, data, modelPath);
            } else {
                this.fleet.update(id, data);
            }

            // Keep queued aircraft data fresh until their model loads
            this.fleet.refreshPending(id, data);
        }

        // Remove aircraft that no longer exist
        this.fleet.forEach((_, id) => {
            if (!activeIds.has(id)) {
                this.fleet.remove(id);
                // Clear any stale per-aircraft overrides so they don't
                // accumulate across long sessions or re-apply if the
                // same acid is recreated with a different type.
                this.stateManager?.setAircraftModelOverride(id, null);
                this.stateManager?.setAircraftScaleOverride(id, null);
            }
        });

        // Also remove from pending aircraft if they no longer exist
        this.fleet.prunePending(activeIds);
    }

    /**
     * React to changes in the per-aircraft model override map. Rebuilds
     * the mesh for any aircraft whose override value changed.
     */
    onOverridesChanged(
        newOverrides: Record<string, string>,
        oldOverrides: Record<string, string>
    ): void {
        const changedIds = new Set<string>();
        for (const id of Object.keys(newOverrides)) {
            if (newOverrides[id] !== oldOverrides[id]) changedIds.add(id);
        }
        for (const id of Object.keys(oldOverrides)) {
            if (newOverrides[id] !== oldOverrides[id]) changedIds.add(id);
        }

        changedIds.forEach((id) => {
            const existing = this.fleet.get(id);
            if (!existing) return;

            const overrideFile = newOverrides[id];
            const resolvedPath = resolveAircraftModelPath(
                this.displayOptions.selectedAircraftModel,
                existing.data.actype,
                overrideFile,
            );

            if (resolvedPath === existing.modelPath) return;

            this.fleet.remove(id);
            this.fleet.create(id, existing.data, resolvedPath);
        });
    }

    /**
     * Re-apply transforms for all aircraft whose scale may have changed.
     * Cheap enough to run on every override change since it just rewrites
     * the transform matrix (no mesh rebuild).
     */
    onScaleOverridesChanged(): void {
        this.fleet.reapplyAllTransforms();
    }

    /**
     * Update scene every frame with proper transform matrix
     */
    protected updateScene(args?: Render3DArgs): void {
        // Check if we're in globe projection mode
        const isGlobe = this.isGlobeProjection();

        // Debug log projection mode changes and handle mesh group transitions
        if (this.lastProjectionMode !== isGlobe) {
            logger.info('Aircraft3DCustomLayer', `[PROJECTION] Switched to ${isGlobe ? 'GLOBE' : 'MERCATOR'} mode`);
            this.lastProjectionMode = isGlobe;

            // Move all aircraft to the appropriate group for the new projection mode
            this.fleet.switchGroups(isGlobe);

            // Re-aim the shared directional lights for the active group's
            // world frame so brightness matches across projections.
            this.updateLightsForProjection(isGlobe);
        }

        // Toggle visibility of groups based on projection mode
        if (this.globeGroup) this.globeGroup.visible = isGlobe;
        if (this.mercatorGroup) this.mercatorGroup.visible = !isGlobe;

        if (isGlobe) {
            if (args) {
                this.transforms.applyGlobeCamera(args);
            }

            // Update all aircraft transforms for globe positioning
            this.fleet.applyGlobeTransforms();
        } else if (args && this.transforms.applyMercatorCamera(args)) {
            // Make sure all aircraft use relative positioning (matrixAutoUpdate = true)
            this.fleet.enableMatrixAutoUpdate();
        }
    }

    /**
     * Re-aim the scene's directional lights for the active projection.
     *
     * The lights live in world space, but the two mesh groups use different
     * world frames: mercator meshes sit in the rotateX(π/2) group (model
     * "up" along world −Z), while globe meshes are origin-relative
     * getMatrixForModel frames (model "up" along world +Y). With the lights
     * fixed in the mercator orientation, globe aircraft were lit edge-on —
     * their visible top surfaces received almost no directional light and
     * rendered noticeably darker than in mercator mode. Reproduce the same
     * key/fill geometry (≈100 above, ±70 horizontal tilt) in each frame.
     */
    private updateLightsForProjection(isGlobe: boolean): void {
        if (!this.directionalLight1 || !this.directionalLight2) return;
        if (isGlobe) {
            this.directionalLight1.position.set(0, 100, 70).normalize();
            this.directionalLight2.position.set(0, 100, -70).normalize();
        } else {
            this.directionalLight1.position.set(0, -70, -100).normalize();
            this.directionalLight2.position.set(0, 70, -100).normalize();
        }
    }

    /**
     * Update display options
     */
    updateDisplayOptions(options: DisplayOptions): void {
        this.displayOptions = options;

        // Update all aircraft sizes based on current projection
        this.fleet.reapplyAllTransforms();
    }

    /**
     * Update the fallback model path from display options. This path is
     * used for aircraft whose ICAO type is unknown or missing; known
     * types are rendered with their category-specific model.
     */
    updateModelPath(): void {
        // No actype/override here: resolves to the forced model, or the
        // default fallback when auto-per-type selection is active.
        this.modelPath = resolveAircraftModelPath(this.displayOptions.selectedAircraftModel, '');
        logger.debug('Aircraft3DCustomLayer', `Fallback model path updated to: ${this.modelPath}`);
    }

    /**
     * Reload aircraft models (invoked when the user changes the fallback
     * model). Clears caches and existing meshes; the next data tick
     * rebuilds everything, each aircraft picking the right per-type model.
     */
    reloadAircraftModel(): void {
        if (!this.scene) {
            logger.debug('Aircraft3DCustomLayer', 'Scene not ready yet, models will load when scene is ready');
            return;
        }

        logger.info('Aircraft3DCustomLayer', `Default aircraft model changed to: ${this.modelPath}`);

        // Remove all existing meshes
        this.fleet.removeAllForReload();

        // Drop cached models so the new fallback (and any stale asset) reloads fresh
        this.modelLoader.clearCache();

        // Preload the new default
        this.modelLoader.load(this.modelPath);
    }

    /**
     * Cleanup all resources
     */
    cleanup(): void {
        this.fleet.clear();
        this.modelLoader.clearAll();
        this.pendingAircraftData = null;
        logger.debug('Aircraft3DCustomLayer', '3D resources cleaned up');
    }
}
