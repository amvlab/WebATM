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

    private addLayerToMap(map: MapLibreMap): void {
        try {
            // Remove any existing layer with the same ID first
            // This ensures the NEW custom layer instance gets onAdd called
            if (map.getLayer(this.customLayer.id)) {
                map.removeLayer(this.customLayer.id);
                logger.debug('Aircraft3DRenderer', 'Removed stale 3D layer before adding new one');
            }
            map.addLayer(this.customLayer);
            logger.debug('Aircraft3DRenderer', '3D layer added to map at top of layer stack');
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
