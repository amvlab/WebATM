import { PolygonShape, DisplayOptions } from '../../../data/types';
import type { MapDisplay } from '../MapDisplay';
import type { StateManager } from '../../../core/StateManager';
import { polygonFeature, toLngLatCoords } from '../../../utils/geojson';
import { logger } from '../../../utils/Logger';
import { extrusionBounds } from './extrusion';
import {
    ensureGeoJSONSource,
    ensureLayer,
    setLayerVisibility,
    safeRemoveLayer,
    safeRemoveSource,
    updateSourceWithRecovery
} from '../../../utils/maplibre';

/**
 * Shape3DRenderer - Renders POLYALT shapes as extruded 3D polygons
 *
 * Uses MapLibre's native fill-extrusion layer to display polygons with
 * altitude data (topAltitude/bottomAltitude) as 3D extruded shapes.
 * Only active when show3DOverlay is enabled.
 */
export class Shape3DRenderer {
    private mapDisplay: MapDisplay;
    private stateManager: StateManager;
    private initialized = false;

    private readonly SOURCE_ID = 'shapes-3d-extrusion';
    private readonly LAYER_ID = 'shapes-3d-extrusion-fill';

    constructor(mapDisplay: MapDisplay, stateManager: StateManager) {
        this.mapDisplay = mapDisplay;
        this.stateManager = stateManager;
    }

    public initialize(): void {
        if (this.initialized) return;

        const map = this.mapDisplay.getMap();
        if (!map) {
            logger.warn('Shape3DRenderer', 'Cannot initialize - map not available');
            return;
        }

        this.setupMapLayers();
        this.initialized = true;
        logger.info('Shape3DRenderer', 'Initialized');
    }

    private setupMapLayers(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const displayOptions = this.stateManager.getDisplayOptions();

        ensureGeoJSONSource(map, this.SOURCE_ID);
        ensureLayer(map, {
            id: this.LAYER_ID,
            source: this.SOURCE_ID,
            type: 'fill-extrusion',
            paint: {
                'fill-extrusion-color': ['get', 'fillColor'],
                'fill-extrusion-height': ['get', 'extrusionHeight'],
                'fill-extrusion-base': ['get', 'extrusionBase'],
                'fill-extrusion-opacity': 0.25
            },
            layout: {
                visibility: (displayOptions.show3DOverlay && displayOptions.showShapes) ? 'visible' : 'none'
            }
        });

        logger.debug('Shape3DRenderer', 'Map layers created');
    }

    /**
     * Render polygons with altitude data as extruded 3D volumes. Polygons
     * without altitude data are skipped - they stay flat in the 2D layers,
     * matching how BlueSky treats shapes with no vertical extent.
     */
    public renderExtrudedPolygons(polygons: PolygonShape[]): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const displayOptions = this.stateManager.getDisplayOptions();

        const features: GeoJSON.Feature[] = [];
        for (const poly of polygons) {
            const bounds = extrusionBounds(poly);
            if (!bounds) continue;
            features.push(polygonFeature(toLngLatCoords(poly.coordinates), {
                name: poly.name,
                fillColor: poly.fillColor || displayOptions.shapeFillColor || '#ff00ff',
                extrusionHeight: bounds.top,
                extrusionBase: bounds.base
            }));
        }

        const ok = updateSourceWithRecovery(map, this.SOURCE_ID, features, () => this.setupMapLayers());
        if (!ok) {
            logger.warn('Shape3DRenderer', `Failed to create source - cannot render ${features.length} extruded polygons`);
        }
    }

    public updateDisplayOptions(displayOptions: DisplayOptions): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;
        setLayerVisibility(map, this.LAYER_ID, displayOptions.show3DOverlay && displayOptions.showShapes);
    }

    /**
     * Mark the layers as lost after a map style change; the next
     * initialize() (driven by ShapeRenderer) re-creates them.
     */
    public onStyleChange(): void {
        this.initialized = false;
    }

    public destroy(): void {
        const map = this.mapDisplay.getMap();
        if (map) {
            safeRemoveLayer(map, this.LAYER_ID);
            safeRemoveSource(map, this.SOURCE_ID);
        }
        this.initialized = false;
        logger.info('Shape3DRenderer', 'Destroyed');
    }
}
