import { GeoJSONSource } from 'maplibre-gl';
import { Shape, PolygonShape, PolylineShape, DisplayOptions } from '../../../data/types';
import type { MapDisplay } from '../MapDisplay';
import type { StateManager } from '../../../core/StateManager';
import { Shape3DRenderer } from './Shape3DRenderer';
import { featureCollection, lineStringFeature, pointFeature, polygonFeature, toLngLatCoords } from '../../../utils/geojson';
import { logger } from '../../../utils/Logger';
import {
    ensureGeoJSONSource,
    ensureLayer,
    setLayerVisibility
} from '../../../utils/maplibre';

/**
 * ShapeRenderer - Handles rendering of geographic shapes (polygons, polylines, etc.)
 *
 * Renders shapes from the simulation:
 * - POLY data (filled polygons like areas, zones, regions)
 * - POLYLINE data (lines like routes, boundaries, paths)
 * - Supports altitude-constrained areas (POLYALT)
 */
export class ShapeRenderer {
    private mapDisplay: MapDisplay;
    private stateManager: StateManager;
    private shape3DRenderer: Shape3DRenderer;
    private initialized = false;
    private unsubscribers: Array<() => void> = [];

    private readonly POLYGON_SOURCE_ID = 'shapes-polygons';
    private readonly POLYGON_FILL_LAYER_ID = 'shapes-polygon-fill';
    private readonly POLYGON_LINE_LAYER_ID = 'shapes-polygon-line';
    private readonly POLYLINE_SOURCE_ID = 'shapes-polylines';
    private readonly POLYLINE_LAYER_ID = 'shapes-polylines';
    private readonly LABELS_SOURCE_ID = 'shapes-labels';
    private readonly LABELS_LAYER_ID = 'shapes-labels';

    constructor(mapDisplay: MapDisplay, stateManager: StateManager) {
        this.mapDisplay = mapDisplay;
        this.stateManager = stateManager;
        this.shape3DRenderer = new Shape3DRenderer(mapDisplay, stateManager);

        // Subscribe once for the renderer's lifetime. initialize() re-runs on
        // every style change and source recovery, so subscriptions must not
        // live there - each re-init would stack another listener and multiply
        // the render work per update.
        this.unsubscribers.push(
            this.stateManager.subscribeToShapes((shapes) => {
                this.renderShapes(shapes);
            }),
            this.stateManager.subscribe('displayOptions', (newOptions) => {
                if (newOptions) {
                    this.updateDisplayOptions(newOptions);
                }
            })
        );
    }

    /**
     * Create map sources/layers and render any shapes that arrived before the
     * map was ready. Safe to re-run after a style change wipes the layers.
     */
    public initialize(): void {
        if (this.initialized) return;

        const map = this.mapDisplay.getMap();
        if (!map) {
            logger.warn('ShapeRenderer', 'Cannot initialize - map not available');
            return;
        }

        this.setupMapLayers();
        this.shape3DRenderer.initialize();

        // Resize map after it settles from adding fill-extrusion layer
        map.once('idle', () => {
            this.mapDisplay.resize();
        });

        const existingShapes = this.stateManager.getAllShapes();
        if (existingShapes.size > 0) {
            logger.debug('ShapeRenderer', `Rendering ${existingShapes.size} existing shapes:`, Array.from(existingShapes.keys()));
            this.renderShapes(existingShapes);
        }

        this.initialized = true;
        logger.info('ShapeRenderer', 'Initialized');
    }

    private setupMapLayers(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        ensureGeoJSONSource(map, this.POLYGON_SOURCE_ID);
        ensureGeoJSONSource(map, this.POLYLINE_SOURCE_ID);
        ensureGeoJSONSource(map, this.LABELS_SOURCE_ID);

        const displayOptions = this.stateManager.getDisplayOptions();

        ensureLayer(map, {
            id: this.POLYGON_FILL_LAYER_ID,
            source: this.POLYGON_SOURCE_ID,
            type: 'fill',
            paint: {
                'fill-color': ['get', 'fillColor'],
                'fill-opacity': ['get', 'fillOpacity']
            },
            layout: {
                visibility: (displayOptions.showShapes && displayOptions.showShapeFill) ? 'visible' : 'none'
            }
        });

        ensureLayer(map, {
            id: this.POLYGON_LINE_LAYER_ID,
            source: this.POLYGON_SOURCE_ID,
            type: 'line',
            paint: {
                'line-color': ['get', 'strokeColor'],
                'line-width': ['get', 'strokeWidth']
            },
            layout: {
                visibility: (displayOptions.showShapes && displayOptions.showShapeLines) ? 'visible' : 'none'
            }
        });

        ensureLayer(map, {
            id: this.POLYLINE_LAYER_ID,
            source: this.POLYLINE_SOURCE_ID,
            type: 'line',
            paint: {
                'line-color': ['get', 'color'],
                'line-width': ['get', 'width']
            },
            layout: {
                visibility: (displayOptions.showShapes && displayOptions.showShapeLines) ? 'visible' : 'none'
            }
        });

        ensureLayer(map, {
            id: this.LABELS_LAYER_ID,
            source: this.LABELS_SOURCE_ID,
            type: 'symbol',
            layout: {
                'text-field': ['get', 'name'],
                'text-size': 12,
                'text-anchor': 'center',
                visibility: (displayOptions.showShapes && displayOptions.showShapeLabels) ? 'visible' : 'none'
            },
            paint: {
                'text-color': displayOptions.shapeLabelsColor || '#ff00ff',
                'text-halo-color': '#ffffff',
                'text-halo-width': 2
            }
        });

        logger.debug('ShapeRenderer', 'Map layers created');
    }

    private renderShapes(shapes: Map<string, Shape>): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        logger.debug('ShapeRenderer', `Rendering ${shapes.size} shapes`);

        const polygons: PolygonShape[] = [];
        const polylines: PolylineShape[] = [];

        shapes.forEach((shape) => {
            if (!shape.visible) return;

            if (shape.type === 'polygon') {
                polygons.push(shape);
            } else if (shape.type === 'polyline') {
                polylines.push(shape);
            }
        });

        this.renderPolygons(polygons);
        this.shape3DRenderer.renderExtrudedPolygons(polygons);
        this.renderPolylines(polylines);
        this.renderLabels(shapes);
    }

    /**
     * Push features to a GeoJSON source. If the source is missing (initial
     * map load, or a style change removed it), re-create the layers once and
     * retry.
     */
    private updateSource(sourceId: string, features: GeoJSON.Feature[]): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        let source = map.getSource(sourceId) as GeoJSONSource | undefined;
        if (!source) {
            logger.debug('ShapeRenderer', `Source ${sourceId} not found, re-creating layers...`);
            this.setupMapLayers();
            source = map.getSource(sourceId) as GeoJSONSource | undefined;
        }

        if (source) {
            source.setData(featureCollection(features));
        } else {
            logger.warn('ShapeRenderer', `Failed to create source ${sourceId} - cannot render ${features.length} features`);
        }
    }

    private renderPolygons(polygons: PolygonShape[]): void {
        const displayOptions = this.stateManager.getDisplayOptions();

        // Ring closure is handled by polygonFeature.
        const features = polygons.map(poly =>
            polygonFeature(toLngLatCoords(poly.coordinates), {
                name: poly.name,
                fillColor: poly.fillColor || displayOptions.shapeFillColor || '#ff00ff',
                fillOpacity: poly.fillOpacity !== undefined ? poly.fillOpacity : 0.2,
                strokeColor: poly.strokeColor || displayOptions.shapeLinesColor || '#ff00ff',
                strokeWidth: poly.strokeWidth || 2,
                topAltitude: poly.topAltitude,
                bottomAltitude: poly.bottomAltitude
            }));

        this.updateSource(this.POLYGON_SOURCE_ID, features);
    }

    private renderPolylines(polylines: PolylineShape[]): void {
        const displayOptions = this.stateManager.getDisplayOptions();

        const features = polylines.map(line =>
            lineStringFeature(toLngLatCoords(line.coordinates), {
                name: line.name,
                color: line.color || displayOptions.shapeLinesColor || '#ff00ff',
                width: line.width || 2
            }));

        this.updateSource(this.POLYLINE_SOURCE_ID, features);
    }

    /**
     * Render shape name labels at polygon centroids / polyline midpoints.
     */
    private renderLabels(shapes: Map<string, Shape>): void {
        const features: GeoJSON.Feature[] = [];

        shapes.forEach((shape) => {
            if (!shape.visible) return;

            let centroid: [number, number];
            if (shape.type === 'polygon') {
                centroid = this.calculatePolygonCentroid(shape.coordinates);
            } else if (shape.type === 'polyline') {
                centroid = this.calculatePolylineMidpoint(shape.coordinates);
            } else {
                return;
            }

            features.push(pointFeature(centroid, { name: shape.name }));
        });

        this.updateSource(this.LABELS_SOURCE_ID, features);
    }

    private calculatePolygonCentroid(coordinates: Array<{lat: number, lng: number}>): [number, number] {
        if (coordinates.length === 0) return [0, 0];

        let sumLng = 0;
        let sumLat = 0;

        coordinates.forEach(coord => {
            sumLng += coord.lng;
            sumLat += coord.lat;
        });

        return [sumLng / coordinates.length, sumLat / coordinates.length];
    }

    private calculatePolylineMidpoint(coordinates: Array<{lat: number, lng: number}>): [number, number] {
        if (coordinates.length === 0) return [0, 0];

        const midIndex = Math.floor(coordinates.length / 2);
        const coord = coordinates[midIndex];
        return [coord.lng, coord.lat];
    }

    private updateDisplayOptions(displayOptions: DisplayOptions): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        // Layer visibility respects the master showShapes toggle.
        const showShapes = displayOptions.showShapes;
        setLayerVisibility(map, this.POLYGON_FILL_LAYER_ID, showShapes && displayOptions.showShapeFill);
        setLayerVisibility(map, this.POLYGON_LINE_LAYER_ID, showShapes && displayOptions.showShapeLines);
        setLayerVisibility(map, this.POLYLINE_LAYER_ID, showShapes && displayOptions.showShapeLines);
        setLayerVisibility(map, this.LABELS_LAYER_ID, showShapes && displayOptions.showShapeLabels);

        if (map.getLayer(this.LABELS_LAYER_ID)) {
            map.setPaintProperty(
                this.LABELS_LAYER_ID,
                'text-color',
                displayOptions.shapeLabelsColor || '#ff00ff'
            );
        }

        this.shape3DRenderer.updateDisplayOptions(displayOptions);

        // Re-render so per-shape fill/line colors pick up the new options.
        const shapes = this.stateManager.getAllShapes();
        if (shapes.size > 0) {
            this.renderShapes(shapes);
        }

        logger.debug('ShapeRenderer', 'Display options updated');
    }

    /**
     * Handle map style changes - re-add layers and re-render.
     */
    public onStyleChange(): void {
        logger.debug('ShapeRenderer', 'Map style changed - recreating layers');
        this.initialized = false;
        this.initialize();

        this.shape3DRenderer.onStyleChange();

        // Resize map after it settles from re-adding fill-extrusion layer
        const map = this.mapDisplay.getMap();
        if (map) {
            map.once('idle', () => {
                this.mapDisplay.resize();
            });
        }

        const shapes = this.stateManager.getAllShapes();
        this.renderShapes(shapes);
    }

    public destroy(): void {
        this.unsubscribers.forEach(unsubscribe => unsubscribe());
        this.unsubscribers = [];
        this.shape3DRenderer.destroy();
        this.initialized = false;
        logger.info('ShapeRenderer', 'Destroyed');
    }
}
