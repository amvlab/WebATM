import type { Map as MapLibreMap } from 'maplibre-gl';
import type { IEntityRenderer } from '../rendering/IEntityRenderer';
import type { AircraftData, DisplayOptions } from '../../../data/types';
import type { StateManager } from '../../../core/StateManager';
import { AircraftRenderer } from './AircraftRenderer';
import type { AircraftShapeDrawer } from './AircraftRenderer';
import { logger } from '../../../utils/Logger';

/**
 * Wrapper for existing AircraftRenderer to implement IEntityRenderer interface
 * This provides a consistent interface for both 2D and 3D renderers while
 * maintaining compatibility with the existing 2D rendering implementation.
 */
export class Aircraft2DRenderer implements IEntityRenderer<AircraftData> {
    private renderer: AircraftRenderer | null = null;
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
     * Eager source/layer setup matters when a 3D overlay is also enabled: the
     * 3D custom layer is added right after this call, so 2D layers must already
     * exist or they'd be lazily appended later and end up on top of the 3D layer.
     */
    initialize(map: MapLibreMap): void {
        this.renderer = new AircraftRenderer(
            map,
            this.displayOptions,
            this.shapeDrawer,
            this.stateManager
        );
        this.renderer.initialize();
    }

    /**
     * The Map is expected to contain a single 'batch' entry holding the full
     * AircraftData, since the underlying 2D renderer processes all aircraft at once.
     */
    updateEntities(entities: Map<string, AircraftData>, _simTime: number): void {
        if (!this.renderer) {
            logger.warn('Aircraft2DRenderer', 'Cannot update entities - renderer not initialized');
            return;
        }

        const aircraftData = entities.get('batch');
        if (aircraftData) {
            this.renderer.updateAircraftDisplay(aircraftData);
        }
    }

    updateDisplayOptions(options: DisplayOptions): void {
        this.displayOptions = options;

        if (this.renderer) {
            this.renderer.updateDisplayOptions(options);
        }
    }

    onStyleChange(): void {
        if (this.renderer) {
            this.renderer.onStyleChange();
        }
    }

    destroy(): void {
        // AircraftRenderer's own layers are torn down by MapLibre layer removal.
        this.renderer = null;
    }

    getType(): '2d' {
        return '2d';
    }

    /** Expose the underlying AircraftRenderer for 2D-specific calls. */
    getRenderer(): AircraftRenderer | null {
        return this.renderer;
    }
}
