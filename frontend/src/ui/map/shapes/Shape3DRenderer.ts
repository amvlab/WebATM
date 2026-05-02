import { GeoJSONSource } from 'maplibre-gl';
import { PolygonShape, DisplayOptions } from '../../../data/types';
import type { MapDisplay } from '../MapDisplay';
import type { StateManager } from '../../../core/StateManager';
import { logger } from '../../../utils/Logger';

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

        if (!map.getSource(this.SOURCE_ID)) {
            map.addSource(this.SOURCE_ID, {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });
        }

        if (!map.getLayer(this.LAYER_ID)) {
            map.addLayer({
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
        }

        logger.debug('Shape3DRenderer', 'Map layers created');
    }

    /**
     * Render polygons as extruded 3D shapes.
     * Polygons with altitude data use their actual top/bottom values.
     * Polygons without altitude data get a default extrusion height.
     */
    public renderExtrudedPolygons(polygons: PolygonShape[]): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const displayOptions = this.stateManager.getDisplayOptions();
        const exaggeration = displayOptions.altitudeExaggeration || 1.0;
        const DEFAULT_EXTRUSION_HEIGHT = 1000; // meters - default height for polygons without altitude

        const features = polygons.map(poly => {
            const coordinates = poly.coordinates.map(c => [c.lng, c.lat]);
            coordinates.push(coordinates[0]); // close ring

            const hasAltitude = poly.topAltitude !== undefined && poly.topAltitude !== null;
            const topAlt = hasAltitude
                ? (poly.topAltitude || 0) * exaggeration
                : DEFAULT_EXTRUSION_HEIGHT * exaggeration;
            const bottomAlt = hasAltitude
                ? (poly.bottomAltitude || 0) * exaggeration
                : 0;

            return {
                type: 'Feature' as const,
                geometry: {
                    type: 'Polygon' as const,
                    coordinates: [coordinates]
                },
                properties: {
                    name: poly.name,
                    fillColor: poly.fillColor || displayOptions.shapeFillColor || '#ff00ff',
                    extrusionHeight: topAlt,
                    extrusionBase: bottomAlt
                }
            };
        });

        const source = map.getSource(this.SOURCE_ID) as GeoJSONSource;
        if (source) {
            source.setData({ type: 'FeatureCollection', features });
        } else {
            logger.debug('Shape3DRenderer', 'Source not found, re-initializing...');
            this.initialized = false;
            this.initialize();

            const sourceAfterInit = map.getSource(this.SOURCE_ID) as GeoJSONSource;
            if (sourceAfterInit) {
                sourceAfterInit.setData({ type: 'FeatureCollection', features });
            } else {
                logger.warn('Shape3DRenderer', `Failed to initialize source - cannot render ${polygons.length} extruded polygons`);
            }
        }
    }

    public updateDisplayOptions(displayOptions: DisplayOptions): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        if (map.getLayer(this.LAYER_ID)) {
            map.setLayoutProperty(
                this.LAYER_ID,
                'visibility',
                (displayOptions.show3DOverlay && displayOptions.showShapes) ? 'visible' : 'none'
            );
        }
    }

    public onStyleChange(): void {
        logger.debug('Shape3DRenderer', 'Map style changed - recreating layers');
        this.initialized = false;
        this.initialize();
    }

    public destroy(): void {
        this.initialized = false;
        logger.info('Shape3DRenderer', 'Destroyed');
    }
}
