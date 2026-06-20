import * as THREE from 'three';
import {
    getDimensionsForAircraftType,
    getRealMaxExtent,
} from '../../../data/aircraftDimensions';
import { logger } from '../../../utils/Logger';
import type { Aircraft3DModelLoader } from './Aircraft3DModelLoader';
import type { Aircraft3DTransforms, AircraftMeshData } from './Aircraft3DTransforms';

/**
 * Aircraft mesh bookkeeping entry
 */
export interface Aircraft3DMesh {
    mesh: THREE.Object3D;
    data: AircraftMeshData;
    modelPath: string;
    lastUpdate: number;
    currentGroup: 'mercator' | 'globe';
}

/**
 * Everything the fleet needs from the owning custom layer. Groups are
 * fetched through getters because they only exist once the scene is ready.
 */
export interface Aircraft3DFleetDeps {
    modelLoader: Aircraft3DModelLoader;
    transforms: Aircraft3DTransforms;
    getMercatorGroup: () => THREE.Group | null;
    getGlobeGroup: () => THREE.Group | null;
    isGlobeProjection: () => boolean;
}

/**
 * Aircraft3DFleet - mesh CRUD and bookkeeping for the 3D aircraft layer,
 * extracted from Aircraft3DCustomLayer.
 *
 * Owns the live mesh registry and the queue of aircraft waiting for their
 * model to load, creates/updates/removes meshes in the projection-correct
 * group, and re-applies transforms across the whole fleet.
 */
export class Aircraft3DFleet {
    private aircraft: Map<string, Aircraft3DMesh> = new Map();
    // Queue for aircraft waiting on a specific model to finish loading
    private pendingAircraft: Map<string, { data: AircraftMeshData; modelPath: string }> = new Map();

    constructor(private readonly deps: Aircraft3DFleetDeps) {}

    get size(): number {
        return this.aircraft.size;
    }

    get(id: string): Aircraft3DMesh | undefined {
        return this.aircraft.get(id);
    }

    forEach(cb: (entry: Aircraft3DMesh, id: string) => void): void {
        this.aircraft.forEach(cb);
    }

    /**
     * Scale factor that converts this model's raw GLB units into
     * real-world meters for the given ICAO. Multiply by the user's
     * visibility settings at render time to get the final scale.
     */
    private computeRealScale(data: AircraftMeshData, modelPath: string): number {
        const rawMax = this.deps.modelLoader.rawMaxDim(modelPath);
        const dims = getDimensionsForAircraftType(data.actype);
        const realMax = getRealMaxExtent(dims);
        return rawMax && rawMax > 0 ? realMax / rawMax : 1;
    }

    /**
     * Create 3D mesh for a new aircraft using the specified model.
     * If the model isn't cached yet, queues the aircraft and kicks off
     * the load; the mesh is created when the model becomes available.
     */
    create(id: string, data: AircraftMeshData, modelPath: string): void {
        const model = this.deps.modelLoader.get(modelPath);
        if (!model) {
            this.pendingAircraft.set(id, { data, modelPath });
            this.deps.modelLoader.load(modelPath);
            logger.debug('Aircraft3DFleet', `Queued aircraft ${id} for ${modelPath}`);
            return;
        }

        const mesh = model.clone();
        mesh.userData.realScale = this.computeRealScale(data, modelPath);
        // Stamp the aircraft id so transform methods can look up
        // per-aircraft overrides without threading the id through every call.
        mesh.userData.aircraftId = id;
        const isGlobe = this.deps.isGlobeProjection();

        if (isGlobe) {
            this.deps.transforms.updateMeshTransformForGlobe(mesh, data);
            this.deps.getGlobeGroup()?.add(mesh);
        } else {
            this.deps.transforms.updateMeshTransform(mesh, data);
            this.deps.getMercatorGroup()?.add(mesh);
        }

        this.aircraft.set(id, {
            mesh,
            data,
            modelPath,
            lastUpdate: Date.now(),
            currentGroup: isGlobe ? 'globe' : 'mercator',
        });

        logger.verbose('Aircraft3DFleet', `Created 3D mesh for aircraft ${id} (${data.actype || 'unknown'}) using ${modelPath}`);
    }

    /**
     * Update existing aircraft mesh
     */
    update(id: string, data: AircraftMeshData): void {
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
        // Note: If projection changed, switchGroups handles moving
        if (aircraftMesh.currentGroup === 'globe') {
            this.deps.transforms.updateMeshTransformForGlobe(aircraftMesh.mesh, data);
        } else {
            this.deps.transforms.updateMeshTransform(aircraftMesh.mesh, data);
        }

        aircraftMesh.data = data;
        aircraftMesh.lastUpdate = Date.now();
    }

    /**
     * Remove aircraft mesh and dispose its resources
     */
    remove(id: string): void {
        const aircraftMesh = this.aircraft.get(id);
        if (!aircraftMesh) return;

        // Remove from the appropriate group based on current tracking
        const group = aircraftMesh.currentGroup === 'globe'
            ? this.deps.getGlobeGroup()
            : this.deps.getMercatorGroup();
        if (group) {
            group.remove(aircraftMesh.mesh);
        }

        this.disposeMeshResources(aircraftMesh.mesh);
        this.aircraft.delete(id);
        logger.verbose('Aircraft3DFleet', `Removed 3D mesh for aircraft ${id}`);
    }

    /**
     * Keep queued aircraft data fresh until their model loads
     */
    refreshPending(id: string, data: AircraftMeshData): void {
        const pending = this.pendingAircraft.get(id);
        if (pending) {
            pending.data = data;
        }
    }

    /**
     * Drop queued aircraft that no longer exist in the simulation
     */
    prunePending(activeIds: Set<string>): void {
        this.pendingAircraft.forEach((_, id) => {
            if (!activeIds.has(id)) {
                this.pendingAircraft.delete(id);
                logger.verbose('Aircraft3DFleet', `Removed pending aircraft ${id}`);
            }
        });
    }

    /**
     * Create meshes for aircraft that were queued waiting for `path` to load.
     */
    processPending(path: string): void {
        const ready: Array<{ id: string; data: AircraftMeshData }> = [];
        this.pendingAircraft.forEach((entry, id) => {
            if (entry.modelPath === path) {
                ready.push({ id, data: entry.data });
            }
        });

        if (ready.length === 0) return;

        logger.debug('Aircraft3DFleet', `Processing ${ready.length} pending aircraft for ${path}`);
        for (const { id, data } of ready) {
            this.pendingAircraft.delete(id);
            this.create(id, data, path);
        }
    }

    /**
     * Re-apply the projection-appropriate transform to every aircraft mesh.
     */
    reapplyAllTransforms(): void {
        const isGlobe = this.deps.isGlobeProjection();
        this.aircraft.forEach((aircraftMesh) => {
            if (isGlobe) {
                this.deps.transforms.updateMeshTransformForGlobe(aircraftMesh.mesh, aircraftMesh.data);
            } else {
                this.deps.transforms.updateMeshTransform(aircraftMesh.mesh, aircraftMesh.data);
            }
        });
    }

    /**
     * Re-apply the origin-relative globe transform to every mesh (per frame).
     */
    applyGlobeTransforms(): void {
        this.aircraft.forEach((aircraftMesh) => {
            this.deps.transforms.updateMeshTransformForGlobe(aircraftMesh.mesh, aircraftMesh.data);
        });
    }

    /**
     * Make sure all aircraft use relative positioning (matrixAutoUpdate)
     * after the mercator camera projection has been applied.
     */
    enableMatrixAutoUpdate(): void {
        this.aircraft.forEach((aircraftMesh) => {
            aircraftMesh.mesh.matrixAutoUpdate = true;
        });
    }

    /**
     * Switch all aircraft meshes between globe and mercator groups
     */
    switchGroups(toGlobe: boolean): void {
        const targetGroup = toGlobe ? this.deps.getGlobeGroup() : this.deps.getMercatorGroup();
        const sourceGroup = toGlobe ? this.deps.getMercatorGroup() : this.deps.getGlobeGroup();

        if (!targetGroup || !sourceGroup) return;

        logger.debug('Aircraft3DFleet', `Switching ${this.aircraft.size} aircraft to ${toGlobe ? 'globe' : 'mercator'} group`);

        this.aircraft.forEach((aircraftMesh) => {
            // Remove from current group
            sourceGroup.remove(aircraftMesh.mesh);

            // Add to target group
            targetGroup.add(aircraftMesh.mesh);

            // Update the transform for the new projection mode
            if (toGlobe) {
                this.deps.transforms.updateMeshTransformForGlobe(aircraftMesh.mesh, aircraftMesh.data);
            } else {
                this.deps.transforms.updateMeshTransform(aircraftMesh.mesh, aircraftMesh.data);
            }

            // Update tracking
            aircraftMesh.currentGroup = toGlobe ? 'globe' : 'mercator';
        });
    }

    /**
     * Remove and dispose every live mesh, keeping the pending queue
     * (used when the user changes the fallback model: in-flight loads
     * still complete and rebuild queued aircraft).
     */
    removeAllForReload(): void {
        this.removeAllMeshes();
    }

    /**
     * Full teardown: remove and dispose every mesh and forget the queue.
     */
    clear(): void {
        this.removeAllMeshes();
        this.pendingAircraft.clear();
    }

    /**
     * Detach every live mesh from its group, dispose its resources, and
     * empty the registry. Shared by reload and full-teardown paths.
     */
    private removeAllMeshes(): void {
        this.aircraft.forEach((aircraftMesh, id) => {
            const group = aircraftMesh.currentGroup === 'globe'
                ? this.deps.getGlobeGroup()
                : this.deps.getMercatorGroup();
            group?.remove(aircraftMesh.mesh);
            this.disposeMeshResources(aircraftMesh.mesh);
            logger.verbose('Aircraft3DFleet', `Removed 3D mesh for aircraft ${id}`);
        });
        this.aircraft.clear();
    }

    /**
     * Dispose of Three.js geometry + material resources inside a mesh
     * hierarchy. Materials may be a single instance or an array (multi-
     * material meshes), so handle both.
     */
    private disposeMeshResources(mesh: THREE.Object3D): void {
        mesh.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                child.geometry.dispose();
                const material = child.material;
                if (Array.isArray(material)) {
                    material.forEach((m) => m.dispose());
                } else if (material instanceof THREE.Material) {
                    material.dispose();
                }
            }
        });
    }
}
