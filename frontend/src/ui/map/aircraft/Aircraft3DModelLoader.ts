import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { logger } from '../../../utils/Logger';

/**
 * Aircraft3DModelLoader - GLTF/GLB model loading and caching for the 3D
 * aircraft layer, extracted from Aircraft3DRenderer.
 *
 * Loads each model path at most once, normalizes materials/textures for
 * quality at small scales, and records the raw bounding-box extent so
 * per-aircraft scaling can convert GLB units to real-world meters.
 */
export class Aircraft3DModelLoader {
    private readonly loader = new GLTFLoader();
    private readonly loadedModels = new Map<string, THREE.Group>();
    // Largest raw bounding-box axis of each loaded GLB (in the GLB's
    // own units). Used to compute the scale factor needed to bring a
    // model to real-world dimensions.
    private readonly rawMaxDims = new Map<string, number>();
    private readonly loadingModels = new Set<string>();

    constructor(private readonly opts: {
        /** Renderer texture-anisotropy limit, queried at normalize time. */
        getMaxAnisotropy: () => number;
        /** Called after a model finishes loading and is cached. */
        onModelLoaded: (path: string) => void;
    }) {}

    /** Cached model for a path, when loaded. */
    public get(path: string): THREE.Group | undefined {
        return this.loadedModels.get(path);
    }

    /** Raw bounding-box max extent recorded when the model loaded. */
    public rawMaxDim(path: string): number | undefined {
        return this.rawMaxDims.get(path);
    }

    /**
     * Load a GLTF/GLB model by URL, caching it for future clones.
     * Idempotent: returns immediately if the model is already loaded
     * or currently loading.
     */
    public load(path: string): void {
        if (this.loadedModels.has(path) || this.loadingModels.has(path)) {
            return;
        }

        this.loadingModels.add(path);
        logger.info('Aircraft3DModelLoader', `Loading aircraft model from ${path}...`);

        this.loader.load(
            path,
            (gltf) => {
                this.loadingModels.delete(path);
                this.normalizeModel(gltf.scene, path);
                this.loadedModels.set(path, gltf.scene);
                logger.info('Aircraft3DModelLoader', `Aircraft model loaded: ${path}`);
                this.opts.onModelLoaded(path);
            },
            (progress) => {
                if (progress.total > 0) {
                    logger.verbose('Aircraft3DModelLoader', `Loading ${path}: ${(progress.loaded / progress.total * 100).toFixed(0)}%`);
                }
            },
            (error) => {
                this.loadingModels.delete(path);
                logger.error('Aircraft3DModelLoader', `Failed to load aircraft model ${path}: ${error}`);
            }
        );
    }

    /**
     * Drop cached models so stale assets reload fresh. In-flight loads
     * are kept; their completions re-populate the cache.
     */
    public clearCache(): void {
        this.loadedModels.clear();
    }

    /** Full teardown: drop the cache and forget in-flight loads. */
    public clearAll(): void {
        this.loadedModels.clear();
        this.loadingModels.clear();
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
        this.rawMaxDims.set(path, rawMax);

        // Get max anisotropy from renderer for best texture quality
        const maxAnisotropy = this.opts.getMaxAnisotropy();

        // Enable smooth shading and improve texture quality on all meshes
        model.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
                const mesh = child as THREE.Mesh;

                // Ensure geometry has proper normals for smooth shading
                if (mesh.geometry) {
                    mesh.geometry.computeVertexNormals();
                }

                // Process materials for smooth shading and texture quality.
                // GLTF materials are MeshStandardMaterial in practice, but the
                // traversal only sees THREE.Material, so view each material
                // through a partial standard-material lens instead of casting.
                const processMaterial = (mat: THREE.Material) => {
                    const std = mat as THREE.Material & Partial<Pick<
                        THREE.MeshStandardMaterial,
                        'flatShading' | 'map' | 'normalMap' | 'roughnessMap' |
                        'metalnessMap' | 'aoMap' | 'emissiveMap'
                    >>;

                    // Enable smooth shading
                    if ('flatShading' in std) {
                        std.flatShading = false;
                    }

                    const sharpenTexture = (texture: THREE.Texture) => {
                        texture.anisotropy = maxAnisotropy;
                        texture.minFilter = THREE.LinearMipmapLinearFilter;
                        texture.magFilter = THREE.LinearFilter;
                        texture.generateMipmaps = true;
                        texture.needsUpdate = true;
                    };

                    // Improve texture filtering for better quality at small
                    // scales, on the base map and all auxiliary texture maps.
                    const textureProps = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const;
                    textureProps.forEach(prop => {
                        const texture = std[prop];
                        if (texture) {
                            sharpenTexture(texture);
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

        logger.debug('Aircraft3DModelLoader', `Model normalized: path=${path}, rawMax=${rawMax.toFixed(2)}, size=${size.x.toFixed(1)}x${size.y.toFixed(1)}x${size.z.toFixed(1)}, anisotropy=${maxAnisotropy}`);
    }
}
