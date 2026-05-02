import type { Map as MapLibreMap } from 'maplibre-gl';
import type { IEntityRenderer } from '../rendering/IEntityRenderer';
import type { AircraftData, DisplayOptions } from '../../../data/types';
import type { StateManager } from '../../../core/StateManager';
import { AircraftRenderer } from './AircraftRenderer';
import type { AircraftShapeDrawer } from './AircraftRenderer';

/**
 * Wrapper for existing AircraftRenderer to implement IEntityRenderer interface
 * This provides a consistent interface for both 2D and 3D renderers while
 * maintaining compatibility with the existing 2D rendering implementation.
 */
export class Aircraft2DRenderer implements IEntityRenderer<AircraftData> {
    private renderer: AircraftRenderer | null = null;
    private map: MapLibreMap | null = null;
    private displayOptions: DisplayOptions;
    private shapeDrawer: AircraftShapeDrawer;
    private stateManager: StateManager;

    constructor(
        displayOptions: DisplayOptions,
        shapeDrawer: AircraftShapeDrawer,
        stateManager: StateManager
    ) {
        this.displayOptions = displayOptions;
        this.shapeDrawer = shapeDrawer;
        this.stateManager = stateManager;
    }

    /**
     * Initialize renderer with map
     * Creates the underlying AircraftRenderer instance and eagerly sets up its
     * sources/layers. Eager setup matters when a 3D overlay is also enabled:
     * the 3D custom layer is added right after this call, so 2D layers must
     * already exist or they'd be lazily appended later and end up on top of
     * the 3D layer.
     */
    initialize(map: MapLibreMap): void {
        this.map = map;

        this.renderer = new AircraftRenderer(
            map,
            this.displayOptions,
            this.shapeDrawer,
            this.stateManager
        );
        this.renderer.initialize();
    }

    /**
     * Update aircraft with new data
     * Delegates to the underlying AircraftRenderer
     *
     * Note: The Map is expected to contain a single 'batch' entry with the full AircraftData,
     * as the underlying 2D renderer processes all aircraft in a batch format.
     */
    updateEntities(entities: Map<string, AircraftData>, simTime: number): void {
        if (!this.renderer) {
            console.warn('Aircraft2DRenderer: Cannot update entities - renderer not initialized');
            return;
        }

        // The 2D renderer expects the full AircraftData structure
        // Extract it from the map (should be a single 'batch' entry)
        const aircraftData = entities.get('batch');
        if (aircraftData) {
            this.renderer.updateAircraftDisplay(aircraftData);
        }
    }

    /**
     * Update display options
     * Updates both local copy and underlying renderer
     */
    updateDisplayOptions(options: DisplayOptions): void {
        this.displayOptions = options;

        if (this.renderer) {
            this.renderer.updateDisplayOptions(options);
        }
    }

    /**
     * Handle map style changes
     * Recreates sprites and layers for new style
     */
    onStyleChange(): void {
        if (this.renderer) {
            this.renderer.onStyleChange();
        }
    }

    /**
     * Cleanup resources
     * The AircraftRenderer cleanup is handled by MapLibre layer removal
     */
    destroy(): void {
        // Future: Could add explicit cleanup method to AircraftRenderer if needed
        this.renderer = null;
        this.map = null;
    }

    /**
     * Get renderer type
     * @returns '2d' for sprite-based rendering
     */
    getType(): '2d' {
        return '2d';
    }

    /**
     * Expose underlying renderer for backward compatibility
     * This allows existing code to access AircraftRenderer-specific methods
     * if needed during migration period
     */
    getRenderer(): AircraftRenderer | null {
        return this.renderer;
    }
}
