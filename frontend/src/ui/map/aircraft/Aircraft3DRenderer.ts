import type { Map as MapLibreMap } from 'maplibre-gl';
import type { IEntityRenderer } from '../rendering/IEntityRenderer';
import type { AircraftData, DisplayOptions } from '../../../data/types';
import type { StateManager } from '../../../core/StateManager';
import { logger } from '../../../utils/Logger';
import { Aircraft3DCustomLayer } from './Aircraft3DCustomLayer';

/**
 * 3D aircraft renderer using Three.js — provides 3D model-based rendering.
 *
 * Thin IEntityRenderer adapter around Aircraft3DCustomLayer: owns the
 * layer's lifecycle on the map (add/remove, style-change reinitialization)
 * and the StateManager override subscriptions.
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

    initialize(map: MapLibreMap): void {
        this.map = map;
        this.whenStyleLoaded(map, () => this.addLayerToMap(map));
    }

    /**
     * Run `callback` once the map style is loaded, polling with
     * requestAnimationFrame (the style.load event may have already fired).
     * Aborts if the renderer is destroyed or re-initialized on another map
     * while waiting, so a stale wait can't act on a dead renderer.
     */
    private whenStyleLoaded(map: MapLibreMap, callback: () => void): void {
        const poll = () => {
            if (this.map !== map) return;
            if (map.isStyleLoaded()) {
                callback();
            } else {
                requestAnimationFrame(poll);
            }
        };
        poll();
    }

    private addLayerToMap(map: MapLibreMap): void {
        try {
            // Remove any stale layer with the same ID so the new custom
            // layer instance gets its onAdd called.
            if (map.getLayer(this.customLayer.id)) {
                map.removeLayer(this.customLayer.id);
            }
            map.addLayer(this.customLayer);
            logger.debug('Aircraft3DRenderer', '3D layer added to map');
        } catch (error) {
            logger.error('Aircraft3DRenderer', `Failed to add 3D layer: ${error}`);
        }
    }

    updateEntities(entities: Map<string, AircraftData>): void {
        const aircraftData = entities.get('batch');
        if (aircraftData) {
            this.customLayer.updateAircraft(aircraftData);
        }
    }

    updateDisplayOptions(options: DisplayOptions): void {
        const oldModel = this.displayOptions.selectedAircraftModel;
        this.displayOptions = options;
        this.customLayer.updateDisplayOptions(options);

        // Reload the model only when the selected aircraft model actually changed.
        const newModel = options.selectedAircraftModel;
        if (oldModel !== newModel) {
            this.customLayer.updateModelPath();
            this.customLayer.reloadAircraftModel();
        }
    }

    onStyleChange(): void {
        const map = this.map;
        if (!map) return;

        // A style change invalidates the custom layer's GL state, so rebuild
        // the layer from scratch instead of re-adding the old instance.
        const reinitializeLayer = () => {
            try {
                if (map.getLayer(this.customLayer.id)) {
                    map.removeLayer(this.customLayer.id);
                }
                this.customLayer.cleanup();
                this.customLayer = new Aircraft3DCustomLayer(this.displayOptions, this.stateManager);
                this.addLayerToMap(map);
                logger.debug('Aircraft3DRenderer', '3D layer reinitialized after style change');
            } catch (error) {
                logger.error('Aircraft3DRenderer', `Failed to reinitialize 3D layer after style change: ${error}`);
            }
        };

        // Defer a frame so MapLibre finishes its own style bookkeeping first.
        requestAnimationFrame(() => this.whenStyleLoaded(map, reinitializeLayer));
    }

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

    getType(): '3d' {
        return '3d';
    }
}
