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
 * Animation clips baked into the GLB (e.g. spinning engines/rotors) are
 * kept alongside the scene so each aircraft clone can play them.
 */
export class Aircraft3DModelLoader {
    private readonly loader = new GLTFLoader();
    private readonly loadedModels = new Map<string, THREE.Group>();
    // Largest raw bounding-box axis of each loaded GLB (in the GLB's
    // own units). Used to compute the scale factor needed to bring a
    // model to real-world dimensions.
    private readonly rawMaxDims = new Map<string, number>();
    // Animation clips shipped in each GLB, keyed by path. Clips are
    // shared read-only data: every aircraft clone binds them through
    // its own AnimationMixer.
    private readonly animationClips = new Map<string, THREE.AnimationClip[]>();
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

    /** Animation clips baked into the GLB (empty for static models). */
    public animations(path: string): THREE.AnimationClip[] {
        return this.animationClips.get(path) ?? [];
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
                // clearAll() ran while this request was in flight: the
                // owner tore everything down, so discard the result
                // instead of resurrecting the cache.
                if (!this.loadingModels.has(path)) {
                    this.disposeModel(gltf.scene);
                    return;
                }
                this.loadingModels.delete(path);
                this.normalizeModel(gltf.scene, path);
                this.loadedModels.set(path, gltf.scene);
                if (gltf.animations && gltf.animations.length > 0) {
                    this.animationClips.set(path, gltf.animations);
                    logger.info('Aircraft3DModelLoader', `Aircraft model loaded: ${path} (${gltf.animations.length} animation clip(s))`);
                } else {
                    logger.info('Aircraft3DModelLoader', `Aircraft model loaded: ${path}`);
                }
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
     * Drop cached models so stale assets reload fresh, disposing each
     * model's GPU resources. In-flight loads are kept; their completions
     * re-populate the cache.
     */
    public clearCache(): void {
        this.loadedModels.forEach((model) => this.disposeModel(model));
        this.loadedModels.clear();
        this.rawMaxDims.clear();
        this.animationClips.clear();
    }

    /**
     * Full teardown: dispose and drop the cache, forget in-flight loads
     * (their completions are discarded in load()'s callback).
     */
    public clearAll(): void {
        this.clearCache();
        this.loadingModels.clear();
    }

    /**
     * Dispose a model's geometry and materials. Aircraft meshes are clones
     * that share these resources, so callers must detach all live meshes
     * first. Materials may be a single instance or an array.
     */
    private disposeModel(model: THREE.Group): void {
        model.traverse((child) => {
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

        // No rotation here: heading is applied per-aircraft in the
        // updateMeshTransform* methods.
        logger.debug('Aircraft3DModelLoader', `Model normalized: path=${path}, rawMax=${rawMax.toFixed(2)}, size=${size.x.toFixed(1)}x${size.y.toFixed(1)}x${size.z.toFixed(1)}, anisotropy=${maxAnisotropy}`);
    }
}
