import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MercatorCoordinate } from 'maplibre-gl';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { CustomLayer3D } from '../rendering/CustomLayer3D';
import type { IEntityRenderer } from '../rendering/IEntityRenderer';
import type { AircraftData, DisplayOptions } from '../../../data/types';
import type { StateManager } from '../../../core/StateManager';
import { AUTO_MODEL_SENTINEL, getModelForAircraftType } from '../../../data/aircraftCategories';
import {
    getDimensionsForAircraftType,
    getRealMaxExtent,
} from '../../../data/aircraftDimensions';
import { logger } from '../../../utils/Logger';

const MODEL_DIR = '/static/models/aircraft/';
const DEFAULT_FALLBACK_MODEL = 'A320.glb';

/**
 * 3D aircraft renderer using Three.js — provides 3D model-based rendering.
 */
export class Aircraft3DRenderer implements IEntityRenderer<AircraftData> {
    private customLayer: Aircraft3DCustomLayer;
    private map: MapLibreMap | null = null;
    private displayOptions: DisplayOptions;
    private stateManager: StateManager | null;
    private unsubscribeOverrides: (() => void) | null = null;
    private unsubscribeScaleOverrides: (() => void) | null = null;

    constructor(displayOptions: DisplayOptions, stateManager?: StateManager) {
        this.displayOptions = displayOptions;
        this.stateManager = stateManager ?? null;
        this.customLayer = new Aircraft3DCustomLayer(displayOptions, this.stateManager);

        // React to per-aircraft override changes immediately so the user
        // sees the new model without waiting for the next data tick.
        if (stateManager) {
            this.unsubscribeOverrides = stateManager.subscribe(
                'aircraftModelOverrides',
                (newOverrides, oldOverrides) => {
                    this.customLayer.onOverridesChanged(newOverrides, oldOverrides);
                }
            );
            this.unsubscribeScaleOverrides = stateManager.subscribe(
                'aircraftScaleOverrides',
                () => {
                    this.customLayer.onScaleOverridesChanged();
                }
            );
        }
    }

    /**
     * Initialize renderer with map
     */
    initialize(map: MapLibreMap): void {
        this.map = map;
        
        // Check if layer already exists and remove it first
        if (map.getLayer(this.customLayer.id)) {
            logger.warn('Aircraft3DRenderer', `Layer ${this.customLayer.id} already exists, removing first`);
            map.removeLayer(this.customLayer.id);
        }
        
        // Wait for style to load before adding custom layer
        if (map.isStyleLoaded()) {
            this.addLayerToMap(map);
        } else {
            // Poll for style to be loaded using requestAnimationFrame
            // This is more reliable than style.load event which may have already fired
            const waitForStyle = () => {
                if (map.isStyleLoaded()) {
                    this.addLayerToMap(map);
                } else {
                    requestAnimationFrame(waitForStyle);
                }
            };
            requestAnimationFrame(waitForStyle);
        }
    }

    /**
     * Helper method to safely add layer to map
     */
    private addLayerToMap(map: MapLibreMap): void {
        try {
            // Remove any existing layer with the same ID first
            // This ensures the NEW custom layer instance gets onAdd called
            if (map.getLayer(this.customLayer.id)) {
                map.removeLayer(this.customLayer.id);
                logger.debug('Aircraft3DRenderer', 'Removed stale 3D layer before adding new one');
            }
            map.addLayer(this.customLayer as any);
            logger.debug('Aircraft3DRenderer', '3D layer added to map at top of layer stack');
        } catch (error) {
            logger.error('Aircraft3DRenderer', `Failed to add 3D layer: ${error}`);
        }
    }

    /**
     * Update aircraft with new data
     */
    updateEntities(entities: Map<string, AircraftData>): void {
        // Extract batch aircraft data
        const aircraftData = entities.get('batch');
        if (aircraftData) {
            this.customLayer.updateAircraft(aircraftData);
        }
    }

    /**
     * Set the scale factor for all aircraft models
     */
    setScaleFactor(scaleFactor: number): void {
        this.customLayer.setScaleFactor(scaleFactor);
    }

    /**
     * Get the current scale factor
     */
    getScaleFactor(): number {
        return this.customLayer.getScaleFactor();
    }

    /**
     * Update display options
     */
    updateDisplayOptions(options: DisplayOptions): void {
        const oldModel = this.displayOptions.selectedAircraftModel;
        this.displayOptions = options;
        this.customLayer.updateDisplayOptions(options);
        
        // Check if aircraft model changed
        const newModel = options.selectedAircraftModel;
        if (oldModel !== newModel) {
            this.customLayer.updateModelPath();
            // Reload model if scene is ready
            this.customLayer.reloadAircraftModel();
        }
    }

    /**
     * Handle map style changes
     */
    onStyleChange(): void {
        if (!this.map) return;

        // For 3D layers, we need to completely reinitialize to ensure proper rendering order
        const reinitializeLayer = () => {
            if (!this.map) return;

            try {
                // Remove existing layer if it exists
                if (this.map.getLayer(this.customLayer.id)) {
                    this.map.removeLayer(this.customLayer.id);
                    logger.debug('Aircraft3DRenderer', 'Removed existing 3D layer before style change');
                }

                // Force cleanup and recreation of the custom layer
                this.customLayer.cleanup();
                this.customLayer = new Aircraft3DCustomLayer(this.displayOptions, this.stateManager);

                // Re-add the layer
                this.addLayerToMap(this.map);
                
                logger.debug('Aircraft3DRenderer', '3D layer reinitialized after style change');
            } catch (error) {
                logger.error('Aircraft3DRenderer', `Failed to reinitialize 3D layer after style change: ${error}`);
            }
        };

        // Wait for style to be fully loaded before reinitializing
        // Use requestAnimationFrame polling which is more reliable than style.load event
        if (this.map.isStyleLoaded()) {
            requestAnimationFrame(reinitializeLayer);
        } else {
            const waitAndReinitialize = () => {
                if (this.map && this.map.isStyleLoaded()) {
                    reinitializeLayer();
                } else if (this.map) {
                    requestAnimationFrame(waitAndReinitialize);
                }
            };
            requestAnimationFrame(waitAndReinitialize);
        }
    }

    /**
     * Cleanup resources
     */
    destroy(): void {
        if (this.unsubscribeOverrides) {
            this.unsubscribeOverrides();
            this.unsubscribeOverrides = null;
        }
        if (this.unsubscribeScaleOverrides) {
            this.unsubscribeScaleOverrides();
            this.unsubscribeScaleOverrides = null;
        }

        try {
            if (this.map && this.map.getLayer(this.customLayer.id)) {
                this.map.removeLayer(this.customLayer.id);
                logger.debug('Aircraft3DRenderer', '3D layer removed from map');
            }
        } catch (error) {
            logger.error('Aircraft3DRenderer', `Error removing 3D layer: ${error}`);
        }

        try {
            this.customLayer.cleanup();
        } catch (error) {
            logger.error('Aircraft3DRenderer', `Error cleaning up custom layer: ${error}`);
        }
        
        this.map = null;
    }

    /**
     * Get renderer type
     */
    getType(): '3d' {
        return '3d';
    }
}

/**
 * Custom MapLibre layer for 3D aircraft rendering
 */
class Aircraft3DCustomLayer extends CustomLayer3D {
    private aircraft: Map<string, Aircraft3DMesh> = new Map();
    private displayOptions: DisplayOptions;
    private loadedModels: Map<string, THREE.Group> = new Map();
    // Largest raw bounding-box axis of each loaded GLB (in the GLB's
    // own units). Used to compute the scale factor needed to bring a
    // model to real-world dimensions.
    private modelRawMaxDim: Map<string, number> = new Map();
    private loadingModels: Set<string> = new Set();
    private modelLoader: GLTFLoader;
    // Default/fallback model path — used when aircraft type is unknown or missing.
    private modelPath: string = `${MODEL_DIR}${DEFAULT_FALLBACK_MODEL}`;
    // Queue for aircraft waiting on a specific model to finish loading
    private pendingAircraft: Map<string, { data: AircraftMeshData; modelPath: string }> = new Map();
    private pendingAircraftData: AircraftData | null = null;
    private baseScaleFactor: number = 10; // Base scale factor multiplied with user's aircraft3DScale setting
    private sceneOrigin: { lng: number; lat: number } | null = null; // Scene origin for relative positioning
    private sceneOriginElevation: number = 0; // Scene origin elevation in meters
    private maxDistanceFromOrigin: number = 10000; // Max distance in meters before repositioning origin
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
        this.modelLoader = new GLTFLoader();
        this.updateModelPath();
    }

    protected onSceneReady(): void {
        logger.debug('Aircraft3DCustomLayer', '3D scene ready');

        // Create two separate groups for different projection modes
        // This allows us to handle coordinate systems differently for each mode

        // Mercator group: uses scene-based coordinate system with rotation
        // Coordinate system: (x=east, y=up, z=north)
        this.mercatorGroup = new THREE.Group();
        this.mercatorGroup.rotateX(Math.PI / 2);
        this.mercatorGroup.scale.multiply(new THREE.Vector3(1, 1, -1));
        this.scene.add(this.mercatorGroup);

        // Globe group: uses raw getMatrixForModel transforms (no scene rotation)
        // MapLibre's getMatrixForModel provides the correct transform for globe projection
        this.globeGroup = new THREE.Group();
        this.scene.add(this.globeGroup);

        // Preload the default fallback model. Per-type models are loaded
        // lazily as aircraft arrive with recognized ICAO codes.
        this.loadModel(this.modelPath);

        // Process any pending aircraft data that arrived before scene was ready
        if (this.pendingAircraftData) {
            logger.debug('Aircraft3DCustomLayer', 'Processing aircraft data that arrived before scene was ready');
            this.updateAircraft(this.pendingAircraftData);
            this.pendingAircraftData = null;
        }
    }

    /**
     * Load a GLTF/GLB model by URL, caching it for future clones.
     * Idempotent: returns immediately if the model is already loaded
     * or currently loading.
     */
    private loadModel(path: string): void {
        if (this.loadedModels.has(path) || this.loadingModels.has(path)) {
            return;
        }

        this.loadingModels.add(path);
        logger.info('Aircraft3DCustomLayer', `Loading aircraft model from ${path}...`);

        this.modelLoader.load(
            path,
            (gltf) => {
                this.loadingModels.delete(path);
                this.normalizeModel(gltf.scene, path);
                this.loadedModels.set(path, gltf.scene);
                logger.info('Aircraft3DCustomLayer', `Aircraft model loaded: ${path}`);
                this.processPendingAircraft(path);
            },
            (progress) => {
                if (progress.total > 0) {
                    logger.verbose('Aircraft3DCustomLayer', `Loading ${path}: ${(progress.loaded / progress.total * 100).toFixed(0)}%`);
                }
            },
            (error) => {
                this.loadingModels.delete(path);
                logger.error('Aircraft3DCustomLayer', `Failed to load aircraft model ${path}: ${error}`);
            }
        );
    }

    /**
     * Normalize the loaded model (materials/textures only).
     *
     * GLB files in this project are authored in wildly different unit
     * systems (some in meters, some in centimeters, some with 1000×
     * scale). Instead of baking a fixed normalization onto the cached
     * scene, we record the raw bounding-box extent per path; the
     * per-aircraft scale is then computed in updateMeshTransform*
     * using real-world dimensions for the aircraft's ICAO type.
     */
    private normalizeModel(model: THREE.Group, path: string): void {
        // Record raw bounding-box extent so per-aircraft scaling can
        // convert GLB units to real-world meters for any ICAO type.
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const rawMax = Math.max(size.x, size.y, size.z) || 1;
        this.modelRawMaxDim.set(path, rawMax);

        // Get max anisotropy from renderer for best texture quality
        const maxAnisotropy = this.renderer?.capabilities?.getMaxAnisotropy?.() || 16;

        // Enable smooth shading and improve texture quality on all meshes
        model.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
                const mesh = child as THREE.Mesh;

                // Ensure geometry has proper normals for smooth shading
                if (mesh.geometry) {
                    mesh.geometry.computeVertexNormals();
                }

                // Process materials for smooth shading and texture quality
                const processMaterial = (mat: THREE.Material) => {
                    // Enable smooth shading
                    if ('flatShading' in mat) {
                        (mat as any).flatShading = false;
                    }

                    // Improve texture filtering for better quality at small scales
                    if ('map' in mat && (mat as any).map) {
                        const texture = (mat as any).map as THREE.Texture;
                        texture.anisotropy = maxAnisotropy;
                        texture.minFilter = THREE.LinearMipmapLinearFilter;
                        texture.magFilter = THREE.LinearFilter;
                        texture.generateMipmaps = true;
                        texture.needsUpdate = true;
                    }

                    // Also process other texture maps (normal, roughness, etc.)
                    const textureProps = ['normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];
                    textureProps.forEach(prop => {
                        if (prop in mat && (mat as any)[prop]) {
                            const texture = (mat as any)[prop] as THREE.Texture;
                            texture.anisotropy = maxAnisotropy;
                            texture.minFilter = THREE.LinearMipmapLinearFilter;
                            texture.magFilter = THREE.LinearFilter;
                            texture.generateMipmaps = true;
                            texture.needsUpdate = true;
                        }
                    });

                    mat.needsUpdate = true;
                };

                if (mesh.material) {
                    if (Array.isArray(mesh.material)) {
                        mesh.material.forEach(processMaterial);
                    } else {
                        processMaterial(mesh.material);
                    }
                }
            }
        });

        // Don't set model.rotation here - it gets ignored anyway because we use mesh.matrix
        // The rotation is applied in updateMeshTransform() via the transform matrix
        // This ensures heading rotation works correctly

        logger.debug('Aircraft3DCustomLayer', `Model normalized: path=${path}, rawMax=${rawMax.toFixed(2)}, size=${size.x.toFixed(1)}x${size.y.toFixed(1)}x${size.z.toFixed(1)}, anisotropy=${maxAnisotropy}`);
    }

    /**
     * Scale factor that converts this model's raw GLB units into
     * real-world meters for the given ICAO. Multiply by the user's
     * visibility settings at render time to get the final scale.
     */
    private computeRealScale(data: AircraftMeshData, modelPath: string): number {
        const rawMax = this.modelRawMaxDim.get(modelPath);
        const dims = getDimensionsForAircraftType(data.actype);
        const realMax = getRealMaxExtent(dims);
        return rawMax && rawMax > 0 ? realMax / rawMax : 1;
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
        if (id && this.stateManager) {
            const override = this.stateManager.getAircraftScaleOverride(id);
            if (override !== null && override > 0) return override;
        }
        return this.displayOptions.aircraft3DScale || 2.0;
    }

    /**
     * Create meshes for aircraft that were queued waiting for `path` to load.
     */
    private processPendingAircraft(path: string): void {
        const ready: Array<{ id: string; data: AircraftMeshData }> = [];
        this.pendingAircraft.forEach((entry, id) => {
            if (entry.modelPath === path) {
                ready.push({ id, data: entry.data });
            }
        });

        if (ready.length === 0) return;

        logger.debug('Aircraft3DCustomLayer', `Processing ${ready.length} pending aircraft for ${path}`);
        for (const { id, data } of ready) {
            this.pendingAircraft.delete(id);
            this.createAircraftMesh(id, data, path);
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

        // Initialize or update scene origin based on aircraft positions
        this.updateSceneOrigin(aircraftData);

        const activeIds = new Set<string>();
        const selected = this.displayOptions.selectedAircraftModel || AUTO_MODEL_SENTINEL;
        const useAutoPerType = selected === AUTO_MODEL_SENTINEL;
        const forcedPath = useAutoPerType ? null : `${MODEL_DIR}${selected}`;

        for (let i = 0; i < aircraftData.id.length; i++) {
            const id = aircraftData.id[i];

            // Skip aircraft with invalid coordinates — matches the 2D
            // renderer's guard. MercatorCoordinate.fromLngLat throws on
            // out-of-range values, which would crash the whole tick.
            const lat = aircraftData.lat[i];
            const lon = aircraftData.lon[i];
            if (
                typeof lat !== 'number' || typeof lon !== 'number' ||
                isNaN(lat) || isNaN(lon) ||
                lat < -90 || lat > 90 || lon < -180 || lon > 180
            ) {
                continue;
            }

            activeIds.add(id);

            const actype = aircraftData.actype?.[i] ?? '';
            // Per-aircraft override wins over auto and fixed-global selection
            const override = this.stateManager?.getAircraftModelOverride(id) ?? null;
            const modelPath = override
                ? `${MODEL_DIR}${override}`
                : (forcedPath ?? `${MODEL_DIR}${getModelForAircraftType(actype, DEFAULT_FALLBACK_MODEL)}`);

            const data: AircraftMeshData = {
                lat: aircraftData.lat[i],
                lon: aircraftData.lon[i],
                alt: aircraftData.alt[i],
                hdg: aircraftData.trk[i],
                selected: false,
                inconf: aircraftData.inconf ? aircraftData.inconf[i] : false,
                actype,
            };

            const existing = this.aircraft.get(id);
            if (!existing) {
                this.createAircraftMesh(id, data, modelPath);
            } else if (existing.modelPath !== modelPath) {
                // Aircraft type (and therefore its model) changed — rebuild the mesh.
                this.removeAircraftMesh(id);
                this.createAircraftMesh(id, data, modelPath);
            } else {
                this.updateAircraftMesh(id, data);
            }

            // Keep queued aircraft data fresh until their model loads
            const pending = this.pendingAircraft.get(id);
            if (pending) {
                pending.data = data;
            }
        }

        // Remove aircraft that no longer exist
        this.aircraft.forEach((_, id) => {
            if (!activeIds.has(id)) {
                this.removeAircraftMesh(id);
                // Clear any stale per-aircraft overrides so they don't
                // accumulate across long sessions or re-apply if the
                // same acid is recreated with a different type.
                this.stateManager?.setAircraftModelOverride(id, null);
                this.stateManager?.setAircraftScaleOverride(id, null);
            }
        });

        // Also remove from pending aircraft if they no longer exist
        this.pendingAircraft.forEach((_, id) => {
            if (!activeIds.has(id)) {
                this.pendingAircraft.delete(id);
                logger.verbose('Aircraft3DCustomLayer', `Removed pending aircraft ${id}`);
            }
        });
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
            const existing = this.aircraft.get(id);
            if (!existing) return;

            const overrideFile = newOverrides[id];
            const resolvedPath = overrideFile
                ? `${MODEL_DIR}${overrideFile}`
                : this.resolvePathForData(existing.data);

            if (resolvedPath === existing.modelPath) return;

            this.removeAircraftMesh(id);
            this.createAircraftMesh(id, existing.data, resolvedPath);
        });
    }

    /**
     * Re-apply transforms for all aircraft whose scale may have changed.
     * Cheap enough to run on every override change since it just rewrites
     * the transform matrix (no mesh rebuild).
     */
    onScaleOverridesChanged(): void {
        const isGlobe = this.isGlobeProjection();
        this.aircraft.forEach((aircraftMesh) => {
            if (isGlobe) {
                this.updateMeshTransformForGlobe(aircraftMesh.mesh, aircraftMesh.data);
            } else {
                this.updateMeshTransform(aircraftMesh.mesh, aircraftMesh.data);
            }
        });
    }

    /**
     * Resolve the model path an aircraft should use when no override
     * is set — mirrors the logic in `updateAircraft`.
     */
    private resolvePathForData(data: AircraftMeshData): string {
        const selected = this.displayOptions.selectedAircraftModel || AUTO_MODEL_SENTINEL;
        if (selected !== AUTO_MODEL_SENTINEL) {
            return `${MODEL_DIR}${selected}`;
        }
        return `${MODEL_DIR}${getModelForAircraftType(data.actype, DEFAULT_FALLBACK_MODEL)}`;
    }

    /**
     * Update scene origin based on aircraft positions
     */
    private updateSceneOrigin(aircraftData: AircraftData): void {
        if (!this.sceneOrigin) {
            // Initialize scene origin with first aircraft or map center
            if (aircraftData.lat.length > 0) {
                this.sceneOrigin = {
                    lng: aircraftData.lon[0],
                    lat: aircraftData.lat[0]
                };
            } else {
                // Fallback to map center if available
                const center = (this as any).map.getCenter();
                this.sceneOrigin = {
                    lng: center.lng,
                    lat: center.lat
                };
            }
            logger.debug('Aircraft3DCustomLayer', `Scene origin set to: ${this.sceneOrigin.lng.toFixed(6)}, ${this.sceneOrigin.lat.toFixed(6)}`);
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
            this.repositionSceneOrigin(aircraftData);
        }
    }

    /**
     * Reposition scene origin to aircraft centroid
     */
    private repositionSceneOrigin(aircraftData: AircraftData): void {
        if (aircraftData.lat.length === 0) return;

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
            return;
        }

        logger.debug('Aircraft3DCustomLayer', `Repositioning scene origin from ${this.sceneOrigin!.lng.toFixed(6)}, ${this.sceneOrigin!.lat.toFixed(6)} to ${newOrigin.lng.toFixed(6)}, ${newOrigin.lat.toFixed(6)}`);

        this.sceneOrigin = newOrigin;

        // Update all existing aircraft positions relative to new origin
        // Only need to update mercator transforms since globe uses absolute positioning
        const isGlobe = this.isGlobeProjection();
        if (!isGlobe) {
            this.aircraft.forEach((aircraftMesh) => {
                this.updateMeshTransform(aircraftMesh.mesh, aircraftMesh.data);
            });
        }
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

        const originMercator = MercatorCoordinate.fromLngLat([this.sceneOrigin.lng, this.sceneOrigin.lat]);
        const targetMercator = MercatorCoordinate.fromLngLat([lng, lat]);

        const mercatorPerMeter = originMercator.meterInMercatorCoordinateUnits();
        const dEast = targetMercator.x - originMercator.x;
        const dEastMeter = dEast / mercatorPerMeter;
        const dNorth = originMercator.y - targetMercator.y;
        const dNorthMeter = dNorth / mercatorPerMeter;

        return { east: dEastMeter, north: dNorthMeter };
    }

    /**
     * Pre-scale altitude so that, after the camera projection multiplies
     * mesh.position.y by `meterInMercatorCoordinateUnits` at the SCENE
     * ORIGIN's lat, the resulting world Z equals altitude × per-point
     * mercator scale. This makes altitude rendering independent of which
     * scene origin this layer happens to be using, so the 3D aircraft
     * (whose origin is the centroid of all aircraft) and the 3D route
     * (whose origin is the selected aircraft) agree on visual height.
     */
    private altitudeForOrigin(altMeters: number, lat: number, lon: number): number {
        if (!this.sceneOrigin) return altMeters;
        const pointMpm = MercatorCoordinate.fromLngLat([lon, lat]).meterInMercatorCoordinateUnits();
        const originMpm = MercatorCoordinate.fromLngLat([this.sceneOrigin.lng, this.sceneOrigin.lat]).meterInMercatorCoordinateUnits();
        return altMeters * (pointMpm / originMpm);
    }

    /**
     * Create 3D mesh for a new aircraft using the specified model.
     * If the model isn't cached yet, queues the aircraft and kicks off
     * the load; the mesh is created when the model becomes available.
     */
    private createAircraftMesh(id: string, data: AircraftMeshData, modelPath: string): void {
        const model = this.loadedModels.get(modelPath);
        if (!model) {
            this.pendingAircraft.set(id, { data, modelPath });
            this.loadModel(modelPath);
            logger.debug('Aircraft3DCustomLayer', `Queued aircraft ${id} for ${modelPath}`);
            return;
        }

        const mesh = model.clone();
        mesh.userData.realScale = this.computeRealScale(data, modelPath);
        // Stamp the aircraft id so transform methods can look up
        // per-aircraft overrides without threading the id through every call.
        mesh.userData.aircraftId = id;
        const isGlobe = this.isGlobeProjection();

        if (isGlobe) {
            this.updateMeshTransformForGlobe(mesh, data);
            this.globeGroup?.add(mesh);
        } else {
            this.updateMeshTransform(mesh, data);
            this.mercatorGroup?.add(mesh);
        }

        this.aircraft.set(id, {
            mesh,
            data,
            modelPath,
            lastUpdate: Date.now(),
            currentGroup: isGlobe ? 'globe' : 'mercator',
        });

        logger.verbose('Aircraft3DCustomLayer', `Created 3D mesh for aircraft ${id} (${data.actype || 'unknown'}) using ${modelPath}`);
    }

    private getDefaultModelFile(): string {
        const selected = this.displayOptions.selectedAircraftModel;
        if (!selected || selected === AUTO_MODEL_SENTINEL) {
            return DEFAULT_FALLBACK_MODEL;
        }
        return selected;
    }


    /**
     * Update existing aircraft mesh
     */
    private updateAircraftMesh(id: string, data: AircraftMeshData): void {
        const aircraftMesh = this.aircraft.get(id);
        if (!aircraftMesh) return;

        // Refresh real-world scale if the aircraft's type changed
        // (e.g. initial tick had an empty actype). The GLB may be
        // shared across variants with different dimensions, so this
        // matters even when the model file is unchanged.
        if (aircraftMesh.data.actype !== data.actype) {
            aircraftMesh.mesh.userData.realScale = this.computeRealScale(
                data,
                aircraftMesh.modelPath,
            );
        }

        // Update transform appropriate for the current group the mesh is in
        // Note: If projection changed, switchAircraftGroups in updateScene will handle moving
        if (aircraftMesh.currentGroup === 'globe') {
            this.updateMeshTransformForGlobe(aircraftMesh.mesh, data);
        } else {
            this.updateMeshTransform(aircraftMesh.mesh, data);
        }

        aircraftMesh.data = data;
        aircraftMesh.lastUpdate = Date.now();
    }

    /**
     * Update mesh position, rotation, and scale using relative positioning
     * Used when scene-based transform is active
     */
    private updateMeshTransform(mesh: THREE.Object3D, data: AircraftMeshData): void {
        // Calculate position relative to scene origin in meters
        const relativePos = this.calculateRelativePosition(data.lat, data.lon);

        // Altitude in meters from BlueSky, lat-corrected so the world Z
        // matches the route renderer (which has a different scene origin).
        const altitudeMeters = this.altitudeForOrigin(data.alt, data.lat, data.lon);

        // Convert aircraft heading to radians (0° = North, clockwise)
        const headingRad = THREE.MathUtils.degToRad(data.hdg);

        // Scale = real-world-calibrated base × user visibility multiplier
        const realScale = this.getMeshRealScale(mesh);
        const finalScale = realScale * this.getUserScaleMultiplier(mesh) * this.baseScaleFactor;

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

        // Disable frustum culling to prevent disappearing at zoom levels
        mesh.frustumCulled = false;
        mesh.traverse((child) => {
            child.frustumCulled = false;
        });

        // Enable automatic matrix updates for this positioning approach
        mesh.matrixAutoUpdate = true;

        // Debug: Log position for first few aircraft
        if (this.aircraft.size < 3) {
            logger.debug('Aircraft3DCustomLayer', `Aircraft position: east=${relativePos.east.toFixed(1)}m, north=${relativePos.north.toFixed(1)}m, alt=${altitudeMeters.toFixed(1)}m, hdg=${data.hdg.toFixed(0)}°`);
        }
    }

    /**
     * Update mesh for globe projection using individual projection-aware transforms
     */
    private updateMeshTransformForGlobe(mesh: THREE.Object3D, data: AircraftMeshData): void {
        try {
            // Altitude already in meters from BlueSky
            const altitudeMeters = data.alt;

            // Convert aircraft heading to radians (0° = North, clockwise)
            const headingRad = THREE.MathUtils.degToRad(data.hdg);

            // Apply 3D aircraft scale factor - for globe mode, getMatrixForModel handles positioning
            // Scale = real-world-calibrated base × user visibility multiplier
            const realScale = this.getMeshRealScale(mesh);
            const finalScale = realScale * (this.displayOptions.aircraft3DScale || 2.0) * this.baseScaleFactor;

            // Check if getMatrixForModel is available (for globe projection)
            if (this.map?.transform?.getMatrixForModel) {
                // Based on MapLibre globe examples, getMatrixForModel expects [lng, lat] order
                const modelMatrix = this.map.transform.getMatrixForModel([data.lon, data.lat], altitudeMeters);

                // Debug logging for first few aircraft
                if (this.aircraft.size <= 3) {
                    logger.debug('Aircraft3DCustomLayer', `[GLOBE] Aircraft at lat=${data.lat.toFixed(6)}, lon=${data.lon.toFixed(6)}, alt=${data.alt}ft, scale=${finalScale}`);
                }

                const l = new THREE.Matrix4().fromArray(modelMatrix)
                    .scale(new THREE.Vector3(finalScale, finalScale, finalScale));

                // Apply heading rotation - in globe space
                // Aviation convention: 0°=N, 90°=E, 180°=S, 270°=W
                // Globe projection coordinate system is different - try simple negation
                const rotationY = new THREE.Matrix4().makeRotationY(-headingRad + Math.PI / 2);
                l.multiply(rotationY);

                // Set the transform - the camera projection matrix will be set in updateScene
                mesh.matrix = l;
                mesh.matrixAutoUpdate = false;
            } else {
                logger.warn('Aircraft3DCustomLayer', '[GLOBE] getMatrixForModel not available, falling back to mercator transform');
                // Fallback to mercator-style transform if globe API not available
                this.updateMeshTransformForMercator(mesh, data);
                return;
            }

            // Disable frustum culling to prevent disappearing at zoom levels
            mesh.frustumCulled = false;
            mesh.traverse((child) => {
                child.frustumCulled = false;
            });
        } catch (error) {
            logger.error('Aircraft3DCustomLayer', `[GLOBE] Error in updateMeshTransformForGlobe: ${error}`);
            // Fallback to mercator transform if anything fails
            this.updateMeshTransformForMercator(mesh, data);
        }
    }

    /**
     * Update mesh for mercator projection using individual transforms
     * Used as fallback when aircraft are spread too far apart
     */
    private updateMeshTransformForMercator(mesh: THREE.Object3D, data: AircraftMeshData): void {
        // Altitude already in meters from BlueSky
        const altitudeMeters = data.alt;

        // Convert aircraft heading to radians (0° = North, clockwise)
        const headingRad = THREE.MathUtils.degToRad(data.hdg);

        // Scale = real-world-calibrated base × user visibility multiplier
        const realScale = this.getMeshRealScale(mesh);
        const finalScale = realScale * this.getUserScaleMultiplier(mesh) * this.baseScaleFactor;

        // Use traditional transform matrix for mercator
        // Aviation convention: 0°=N, 90°=E, 180°=S, 270°=W
        // Three.js Y-rotation: 0=+Z(north), π/2=+X(east), π=-Z(south), 3π/2=-X(west)
        // Model correction: subtract π/2 to account for model's default orientation
        const transformMatrix = this.createTransformMatrix(
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

        // Disable frustum culling to prevent disappearing at zoom levels
        mesh.frustumCulled = false;
        mesh.traverse((child) => {
            child.frustumCulled = false;
        });
    }




    /**
     * Remove aircraft mesh
     */
    private removeAircraftMesh(id: string): void {
        const aircraftMesh = this.aircraft.get(id);
        if (!aircraftMesh) return;

        // Remove from the appropriate group based on current tracking
        const group = aircraftMesh.currentGroup === 'globe' ? this.globeGroup : this.mercatorGroup;
        if (group) {
            group.remove(aircraftMesh.mesh);
        }

        // Dispose of geometries and materials
        aircraftMesh.mesh.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                child.geometry.dispose();
                if (child.material instanceof THREE.Material) {
                    child.material.dispose();
                }
            }
        });

        this.aircraft.delete(id);
        logger.verbose('Aircraft3DCustomLayer', `Removed 3D mesh for aircraft ${id}`);
    }

    /**
     * Update scene every frame with proper transform matrix
     */
    protected updateScene(args?: any): void {
        // Check if we're in globe projection mode
        const isGlobe = this.isGlobeProjection();

        // Debug log projection mode changes and handle mesh group transitions
        if (this.lastProjectionMode !== isGlobe) {
            logger.info('Aircraft3DCustomLayer', `[PROJECTION] Switched to ${isGlobe ? 'GLOBE' : 'MERCATOR'} mode`);
            this.lastProjectionMode = isGlobe;

            // Move all aircraft to the appropriate group for the new projection mode
            this.switchAircraftGroups(isGlobe);
        }

        // Toggle visibility of groups based on projection mode
        if (this.globeGroup) this.globeGroup.visible = isGlobe;
        if (this.mercatorGroup) this.mercatorGroup.visible = !isGlobe;

        if (isGlobe) {
            // In globe mode: set camera projection to mainMatrix only
            // Each aircraft mesh has its own transform from getMatrixForModel
            if (args) {
                this.camera.projectionMatrix = new THREE.Matrix4().fromArray(
                    args.defaultProjectionData.mainMatrix
                );
            }

            // Update all aircraft transforms for globe positioning
            this.aircraft.forEach((aircraftMesh) => {
                this.updateMeshTransformForGlobe(aircraftMesh.mesh, aircraftMesh.data);
            });
        } else {
            // In mercator mode, use the scene-based transform applied to mercatorGroup
            if (this.sceneOrigin && args) {
                // Get scene origin elevation (could be terrain-aware in future)
                const sceneOriginElevation = this.sceneOriginElevation;
                const sceneOriginMercator = MercatorCoordinate.fromLngLat(
                    [this.sceneOrigin.lng, this.sceneOrigin.lat],
                    sceneOriginElevation
                );

                // Create scene transform
                const sceneTransform = {
                    translateX: sceneOriginMercator.x,
                    translateY: sceneOriginMercator.y,
                    translateZ: sceneOriginMercator.z,
                    scale: sceneOriginMercator.meterInMercatorCoordinateUnits()
                };

                // Apply transform: mainMatrix * translation * scale
                // The mercatorGroup already has rotation applied, so we just need position/scale
                const m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix);
                const l = new THREE.Matrix4()
                    .makeTranslation(sceneTransform.translateX, sceneTransform.translateY, sceneTransform.translateZ)
                    .scale(new THREE.Vector3(sceneTransform.scale, -sceneTransform.scale, sceneTransform.scale));

                this.camera.projectionMatrix = m.multiply(l);

                // Make sure all aircraft use relative positioning (matrixAutoUpdate = true)
                this.aircraft.forEach((aircraftMesh) => {
                    aircraftMesh.mesh.matrixAutoUpdate = true;
                });
            }
        }
    }

    /**
     * Switch all aircraft meshes between globe and mercator groups
     */
    private switchAircraftGroups(toGlobe: boolean): void {
        const targetGroup = toGlobe ? this.globeGroup : this.mercatorGroup;
        const sourceGroup = toGlobe ? this.mercatorGroup : this.globeGroup;

        if (!targetGroup || !sourceGroup) return;

        logger.debug('Aircraft3DCustomLayer', `Switching ${this.aircraft.size} aircraft to ${toGlobe ? 'globe' : 'mercator'} group`);

        this.aircraft.forEach((aircraftMesh) => {
            // Remove from current group
            sourceGroup.remove(aircraftMesh.mesh);

            // Add to target group
            targetGroup.add(aircraftMesh.mesh);

            // Update the transform for the new projection mode
            if (toGlobe) {
                this.updateMeshTransformForGlobe(aircraftMesh.mesh, aircraftMesh.data);
            } else {
                this.updateMeshTransform(aircraftMesh.mesh, aircraftMesh.data);
            }

            // Update tracking
            aircraftMesh.currentGroup = toGlobe ? 'globe' : 'mercator';
        });
    }

    /**
     * Set the global scale factor for all aircraft models
     */
    setScaleFactor(scaleFactor: number): void {
        this.baseScaleFactor = scaleFactor;

        // Update all existing aircraft to use the new scale
        const isGlobe = this.isGlobeProjection();
        this.aircraft.forEach((aircraftMesh) => {
            if (isGlobe) {
                this.updateMeshTransformForGlobe(aircraftMesh.mesh, aircraftMesh.data);
            } else {
                this.updateMeshTransform(aircraftMesh.mesh, aircraftMesh.data);
            }
        });
    }

    /**
     * Get the current scale factor
     */
    getScaleFactor(): number {
        return this.baseScaleFactor;
    }

    /**
     * Update display options
     */
    updateDisplayOptions(options: DisplayOptions): void {
        this.displayOptions = options;

        // Update all aircraft sizes based on current projection
        const isGlobe = this.isGlobeProjection();
        this.aircraft.forEach((aircraftMesh) => {
            if (isGlobe) {
                this.updateMeshTransformForGlobe(aircraftMesh.mesh, aircraftMesh.data);
            } else {
                this.updateMeshTransform(aircraftMesh.mesh, aircraftMesh.data);
            }
        });
    }

    /**
     * Update the fallback model path from display options. This path is
     * used for aircraft whose ICAO type is unknown or missing; known
     * types are rendered with their category-specific model.
     */
    updateModelPath(): void {
        this.modelPath = `${MODEL_DIR}${this.getDefaultModelFile()}`;
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
        this.aircraft.forEach((aircraftMesh, id) => {
            const group = aircraftMesh.currentGroup === 'globe' ? this.globeGroup : this.mercatorGroup;
            if (group) {
                group.remove(aircraftMesh.mesh);
            }
            aircraftMesh.mesh.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                    child.geometry.dispose();
                    if (child.material instanceof THREE.Material) {
                        child.material.dispose();
                    }
                }
            });
            logger.verbose('Aircraft3DCustomLayer', `Removed aircraft mesh for model reload: ${id}`);
        });
        this.aircraft.clear();

        // Drop cached models so the new fallback (and any stale asset) reloads fresh
        this.loadedModels.clear();

        // Preload the new default
        this.loadModel(this.modelPath);
    }

    /**
     * Cleanup all resources
     */
    cleanup(): void {
        this.aircraft.forEach((_, id) => {
            this.removeAircraftMesh(id);
        });
        this.aircraft.clear();
        this.pendingAircraft.clear();
        this.loadedModels.clear();
        this.loadingModels.clear();
        this.pendingAircraftData = null;
        logger.debug('Aircraft3DCustomLayer', '3D resources cleaned up');
    }
}

/**
 * Aircraft mesh data structure
 */
interface Aircraft3DMesh {
    mesh: THREE.Object3D;
    data: AircraftMeshData;
    modelPath: string;
    lastUpdate: number;
    currentGroup: 'mercator' | 'globe';
}

/**
 * Simplified aircraft data for 3D rendering
 */
interface AircraftMeshData {
    lat: number;
    lon: number;
    alt: number;
    hdg: number;
    selected: boolean;
    inconf: boolean;
    actype: string;
}
