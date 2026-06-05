import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';
import type { Map as MapLibreMap, CustomLayerInterface } from 'maplibre-gl';

/**
 * Base class for Three.js custom layers in MapLibre GL
 *
 * This class provides the foundation for rendering 3D content using Three.js
 * within MapLibre GL maps. It handles the integration between Three.js and
 * MapLibre's rendering pipeline.
 *
 * Based on MapLibre example:
 * https://maplibre.org/maplibre-gl-js/docs/examples/add-3d-model-threejs/
 */
export abstract class CustomLayer3D implements CustomLayerInterface {
    id: string;
    type: 'custom' = 'custom';
    renderingMode: '3d' = '3d';

    protected camera!: THREE.Camera;
    protected scene!: THREE.Scene;
    protected renderer!: THREE.WebGLRenderer;
    protected map!: MapLibreMap;

    constructor(id: string) {
        this.id = id;
    }

    /**
     * Initialize Three.js scene (called by MapLibre when layer is added)
     * @param map - MapLibre map instance
     * @param gl - WebGL rendering context
     */
    onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
        this.map = map;

        // Initialize Three.js camera (projection will be set from MapLibre)
        this.camera = new THREE.Camera();

        // Initialize Three.js scene
        this.scene = new THREE.Scene();

        // Add lighting to the scene
        this.setupLighting();

        // Initialize Three.js renderer using MapLibre's canvas and GL context
        this.renderer = new THREE.WebGLRenderer({
            canvas: map.getCanvas(),
            context: gl as WebGLRenderingContext,
            antialias: true
        });

        // Don't auto-clear - MapLibre manages the clear
        this.renderer.autoClear = false;

        // Match the Three.js WebGL viewport to MapLibre's canvas buffer.
        // MapLibre already sizes the canvas for the device pixel ratio (e.g. 2x on
        // Retina), so we keep Three's pixelRatio at 1 and point its viewport at the
        // physical buffer. Calling setPixelRatio(devicePixelRatio) here would instead
        // make Three's WebGL viewport twice the canvas size on HiDPI displays,
        // distorting the scene until a manual window resize re-synced it.
        this.syncRendererSize();

        // Set color space for accurate color rendering
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;

        // Enable tone mapping for better lighting
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;

        // Subclass-specific initialization
        this.onSceneReady();
    }

    /**
     * Keep the Three.js renderer's WebGL viewport matched to MapLibre's canvas.
     *
     * The renderer shares MapLibre's canvas and GL context. MapLibre owns the canvas
     * and its drawing-buffer size (already scaled for the device pixel ratio), so we
     * keep Three's pixelRatio = 1 and only point its viewport at the physical buffer.
     *
     * We deliberately use setViewport() rather than setSize(): setSize() writes to
     * canvas.width / canvas.height, and assigning to those attributes resets the
     * shared WebGL drawing buffer on every resize (even when the value is unchanged,
     * notably on Safari / HiDPI MacBooks). That reset desyncs MapLibre's painter from
     * the buffer and distorts the whole map. setViewport() only updates Three's
     * internal viewport, leaving the canvas entirely under MapLibre's control, and
     * self-heals on every window/canvas resize and DPR change.
     */
    private syncRendererSize(): void {
        const canvas = this.map.getCanvas();
        if (this.renderer.getPixelRatio() !== 1) {
            this.renderer.setPixelRatio(1);
        }
        this.renderer.setViewport(0, 0, canvas.width, canvas.height);
    }

    /**
     * Setup scene lighting
     * Override this method to customize lighting for your scene
     */
    protected setupLighting(): void {
        // Main directional light. z<0 matches the mercator group's rotateX(π/2),
        // which places the model's "up" along scene -Z.
        const directionalLight1 = new THREE.DirectionalLight(0xffffff, 1.5);
        directionalLight1.position.set(0, -70, -100).normalize();
        this.scene.add(directionalLight1);

        // Fill light from below to reduce harsh shadows
        const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight2.position.set(0, 70, -100).normalize();
        this.scene.add(directionalLight2);

        // Ambient light for overall scene illumination
        const ambientLight = new THREE.AmbientLight(0xcccccc, 1.2);
        this.scene.add(ambientLight);
    }

    /**
     * Called when scene is ready for subclass to add objects
     * Override this to add your 3D objects to the scene
     */
    protected abstract onSceneReady(): void;

    /**
     * Render the scene (called by MapLibre every frame)
     * @param gl - WebGL rendering context
     * @param matrix - Transformation matrix (deprecated, use args)
     */
    render(gl: WebGLRenderingContext | WebGL2RenderingContext, matrix: number[]): void;
    render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: any): void;
    render(gl: WebGLRenderingContext | WebGL2RenderingContext, matrixOrArgs: any): void {
        // Handle both old and new MapLibre API signatures
        const args = Array.isArray(matrixOrArgs)
            ? { defaultProjectionData: { mainMatrix: matrixOrArgs } }
            : matrixOrArgs;

        // Keep the renderer's drawing buffer in sync with MapLibre's canvas so the
        // WebGL viewport stays correct after resizes / DPR changes (Retina toggles).
        this.syncRendererSize();

        // Update scene objects first (subclass may override camera projection)
        this.updateScene(args);

        // Set default camera projection if not overridden by subclass
        if (this.camera.projectionMatrix.equals(new THREE.Matrix4())) {
            const projectionMatrix = new THREE.Matrix4().fromArray(
                args.defaultProjectionData.mainMatrix
            );
            this.camera.projectionMatrix = projectionMatrix;
        }

        // Render Three.js scene
        this.renderer.resetState();

        // Clear the depth buffer so that MapLibre's native layers (e.g. fill-extrusion)
        // don't block Three.js objects via depth testing. The native layers' color output
        // remains visible, but their depth values won't occlude our 3D content.
        gl.clear(gl.DEPTH_BUFFER_BIT);

        this.renderer.render(this.scene, this.camera);

        // Trigger continuous rendering
        this.map.triggerRepaint();
    }

    /**
     * Update scene objects before rendering
     * Override this to update your 3D objects each frame
     * @param args - Rendering arguments from MapLibre
     */
    protected abstract updateScene(args?: any): void;

    /**
     * Convert longitude/latitude to Mercator coordinates
     * @param lng - Longitude in degrees
     * @param lat - Latitude in degrees
     * @param altitude - Altitude in meters
     * @returns Mercator coordinates and scale factor
     */
    protected lngLatToMercator(
        lng: number,
        lat: number,
        altitude: number = 0
    ): { x: number; y: number; z: number; scale: number } {
        // Use MapLibre's MercatorCoordinate for accurate conversion
        const mercator = MercatorCoordinate.fromLngLat(
            [lng, lat],
            altitude
        );

        return {
            x: mercator.x,
            y: mercator.y,
            z: mercator.z,
            scale: mercator.meterInMercatorCoordinateUnits()
        };
    }

    /**
     * Create a transformation matrix for positioning an object on the map
     * @param lng - Longitude in degrees
     * @param lat - Latitude in degrees
     * @param altitude - Altitude in meters
     * @param heading - Heading in radians (0 = North, clockwise)
     * @param pitch - Pitch in radians (rotation around X axis)
     * @param roll - Roll in radians (rotation around Y axis)
     * @param scale - Additional scale factor
     * @returns Three.js transformation matrix
     */
    protected createTransformMatrix(
        lng: number,
        lat: number,
        altitude: number,
        heading: number = 0,
        pitch: number = 0,
        roll: number = 0,
        scale: number = 1
    ): THREE.Matrix4 {
        const mercator = this.lngLatToMercator(lng, lat, altitude);

        // Create rotation matrices
        const rotationX = new THREE.Matrix4().makeRotationAxis(
            new THREE.Vector3(1, 0, 0),
            pitch
        );
        const rotationY = new THREE.Matrix4().makeRotationAxis(
            new THREE.Vector3(0, 1, 0),
            roll
        );
        const rotationZ = new THREE.Matrix4().makeRotationAxis(
            new THREE.Vector3(0, 0, 1),
            heading
        );

        // Combine transformations: translate, scale, then rotate
        return new THREE.Matrix4()
            .makeTranslation(mercator.x, mercator.y, mercator.z)
            .scale(
                new THREE.Vector3(
                    mercator.scale * scale,
                    -mercator.scale * scale, // Flip Y for MapLibre coordinate system
                    mercator.scale * scale
                )
            )
            .multiply(rotationZ)
            .multiply(rotationY)
            .multiply(rotationX);
    }

    /**
     * Create a projection-aware transformation matrix using MapLibre's transform
     * Works with both mercator and globe projections
     * @param lng - Longitude in degrees
     * @param lat - Latitude in degrees
     * @param altitude - Altitude in meters
     * @param heading - Heading in radians (0 = North, clockwise)
     * @param pitch - Pitch in radians (rotation around X axis)
     * @param roll - Roll in radians (rotation around Y axis)
     * @param scale - Additional scale factor
     * @returns Three.js transformation matrix
     */
    protected createProjectionAwareMatrix(
        lng: number,
        lat: number,
        altitude: number,
        heading: number = 0,
        pitch: number = 0,
        roll: number = 0,
        scale: number = 1
    ): THREE.Matrix4 {
        try {
            // Check if getMatrixForModel is available
            if (!this.map?.transform?.getMatrixForModel) {
                // Fallback to traditional transform if projection-aware transform is not available
                return this.createTransformMatrix(lng, lat, altitude, heading, pitch, roll, scale);
            }

            // Use MapLibre's projection-aware transform
            const modelMatrix = this.map.transform.getMatrixForModel([lng, lat], altitude);
            
            // Create rotation matrices
            const rotationX = new THREE.Matrix4().makeRotationAxis(
                new THREE.Vector3(1, 0, 0),
                pitch
            );
            const rotationY = new THREE.Matrix4().makeRotationAxis(
                new THREE.Vector3(0, 1, 0),
                roll
            );
            const rotationZ = new THREE.Matrix4().makeRotationAxis(
                new THREE.Vector3(0, 0, 1),
                heading
            );

            // Apply scale and rotations to the model matrix
            const transform = new THREE.Matrix4().fromArray(modelMatrix)
                .scale(new THREE.Vector3(scale, scale, scale))
                .multiply(rotationZ)
                .multiply(rotationY)
                .multiply(rotationX);

            return transform;
        } catch (error) {
            // Fallback to traditional transform if there's any error
            return this.createTransformMatrix(lng, lat, altitude, heading, pitch, roll, scale);
        }
    }

    /**
     * Check if the current map projection is globe
     * @returns True if globe projection is active
     */
    protected isGlobeProjection(): boolean {
        try {
            const projection = this.map?.getProjection?.();
            return projection?.type === 'globe';
        } catch (error) {
            // Fallback to mercator if projection detection fails
            return false;
        }
    }

    /**
     * Cleanup when layer is removed (called by MapLibre)
     * Override to cleanup any resources
     */
    onRemove?(_map: MapLibreMap, _gl: WebGLRenderingContext | WebGL2RenderingContext): void {
        // Cleanup will be handled by subclass if needed
    }
}
