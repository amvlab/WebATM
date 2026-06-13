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

    // Layer and source IDs
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
    }

    /**
     * Initialize the shape renderer
     * Creates map sources and layers, subscribes to shape changes
     */
    public initialize(): void {
        if (this.initialized) return;

        const map = this.mapDisplay.getMap();
        if (!map) {
            logger.warn('ShapeRenderer', 'Cannot initialize - map not available');
            return;
        }

        // Set up map layers for shape rendering
        this.setupMapLayers();

        // Initialize 3D extrusion renderer
        this.shape3DRenderer.initialize();

        // Resize map after it settles from adding fill-extrusion layer
        map.once('idle', () => {
            this.mapDisplay.resize();
        });

        // Subscribe to shape changes
        this.stateManager.subscribeToShapes((shapes) => {
            this.renderShapes(shapes);
        });

        // Subscribe to display options changes
        this.stateManager.subscribe('displayOptions', (newOptions) => {
            if (newOptions) {
                this.updateDisplayOptions(newOptions);
            }
        });

        // Render any existing shapes that were added before initialization
        const existingShapes = this.stateManager.getAllShapes();
        logger.debug('ShapeRenderer', `Checking for existing shapes: ${existingShapes.size} shapes found`);
        if (existingShapes.size > 0) {
            logger.debug('ShapeRenderer', `Rendering ${existingShapes.size} existing shapes:`, Array.from(existingShapes.keys()));
            this.renderShapes(existingShapes);
        } else {
            logger.debug('ShapeRenderer', 'No existing shapes to render');
        }

        this.initialized = true;
        logger.info('ShapeRenderer', 'Initialized');
    }

    /**
     * Set up MapLibre GL sources and layers for shape rendering
     */
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

    /**
     * Render all shapes on the map
     */
    private renderShapes(shapes: Map<string, Shape>): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        logger.debug('ShapeRenderer', `Rendering ${shapes.size} shapes`);

        // Separate shapes by type
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

        // Render polygons (2D flat + 3D extruded)
        this.renderPolygons(polygons);
        this.shape3DRenderer.renderExtrudedPolygons(polygons);

        // Render polylines
        this.renderPolylines(polylines);

        // Render labels
        this.renderLabels(shapes);
    }

    /**
     * Render polygon shapes
     */
    private renderPolygons(polygons: PolygonShape[]): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const displayOptions = this.stateManager.getDisplayOptions();

        // Convert polygons to GeoJSON features (ring closed by polygonFeature)
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

        // Update polygon source
        const source = map.getSource(this.POLYGON_SOURCE_ID) as GeoJSONSource;
        if (source) {
            source.setData(featureCollection(features));
        } else {
            // Source not ready yet, which can happen:
            // 1. During initial map load
            // 2. After map style change (sources are removed)
            // In both cases, we need to initialize the renderer
            logger.debug('ShapeRenderer', 'Polygon source not found, initializing renderer...');
            this.initialized = false;
            this.initialize();

            // After initialization, try updating again
            const sourceAfterInit = map.getSource(this.POLYGON_SOURCE_ID) as GeoJSONSource;
            if (sourceAfterInit) {
                sourceAfterInit.setData(featureCollection(features));
            } else {
                logger.warn('ShapeRenderer', `Failed to initialize polygon source - cannot render ${polygons.length} polygons`);
            }
        }
    }

    /**
     * Render polyline shapes
     */
    private renderPolylines(polylines: PolylineShape[]): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const displayOptions = this.stateManager.getDisplayOptions();

        // Convert polylines to GeoJSON features
        const features = polylines.map(line =>
            lineStringFeature(toLngLatCoords(line.coordinates), {
                name: line.name,
                color: line.color || displayOptions.shapeLinesColor || '#ff00ff',
                width: line.width || 2
            }));

        // Update polyline source
        const source = map.getSource(this.POLYLINE_SOURCE_ID) as GeoJSONSource;
        if (source) {
            source.setData(featureCollection(features));
        } else {
            // Source not ready yet, which can happen:
            // 1. During initial map load
            // 2. After map style change (sources are removed)
            // In both cases, we need to initialize the renderer
            logger.debug('ShapeRenderer', 'Polyline source not found, initializing renderer...');
            this.initialized = false;
            this.initialize();

            // After initialization, try updating again
            const sourceAfterInit = map.getSource(this.POLYLINE_SOURCE_ID) as GeoJSONSource;
            if (sourceAfterInit) {
                sourceAfterInit.setData(featureCollection(features));
            } else {
                logger.warn('ShapeRenderer', `Failed to initialize polyline source - cannot render ${polylines.length} polylines`);
            }
        }
    }

    /**
     * Render shape labels
     */
    private renderLabels(shapes: Map<string, Shape>): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        // Create label features at shape centroids
        const features: GeoJSON.Feature[] = [];

        shapes.forEach((shape) => {
            if (!shape.visible) return;

            // Calculate centroid
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

        // Update labels source
        const source = map.getSource(this.LABELS_SOURCE_ID) as GeoJSONSource;
        if (source) {
            source.setData(featureCollection(features));
        } else {
            // Source not ready yet, which can happen:
            // 1. During initial map load
            // 2. After map style change (sources are removed)
            // In both cases, we need to initialize the renderer
            logger.debug('ShapeRenderer', 'Labels source not found, initializing renderer...');
            this.initialized = false;
            this.initialize();

            // After initialization, try updating again
            const sourceAfterInit = map.getSource(this.LABELS_SOURCE_ID) as GeoJSONSource;
            if (sourceAfterInit) {
                sourceAfterInit.setData(featureCollection(features));
            } else {
                logger.warn('ShapeRenderer', `Failed to initialize labels source - cannot render labels`);
            }
        }
    }

    /**
     * Calculate centroid of a polygon
     */
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

    /**
     * Calculate midpoint of a polyline
     */
    private calculatePolylineMidpoint(coordinates: Array<{lat: number, lng: number}>): [number, number] {
        if (coordinates.length === 0) return [0, 0];

        const midIndex = Math.floor(coordinates.length / 2);
        const coord = coordinates[midIndex];
        return [coord.lng, coord.lat];
    }

    /**
     * Update display options (visibility, colors, etc.)
     */
    private updateDisplayOptions(displayOptions: DisplayOptions): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        // Update layer visibility - respect master showShapes toggle
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

        // Update 3D extrusion renderer
        this.shape3DRenderer.updateDisplayOptions(displayOptions);

        // Re-render shapes with updated colors
        // This ensures fill and line colors update when the user changes them in display options
        const shapes = this.stateManager.getAllShapes();
        if (shapes.size > 0) {
            this.renderShapes(shapes);
        }

        logger.debug('ShapeRenderer', 'Display options updated');
    }

    /**
     * Handle map style changes - re-add layers
     */
    public onStyleChange(): void {
        logger.debug('ShapeRenderer', 'Map style changed - recreating layers');
        this.initialized = false;
        this.initialize();

        // Re-create 3D extrusion layers
        this.shape3DRenderer.onStyleChange();

        // Resize map after it settles from re-adding fill-extrusion layer
        const map = this.mapDisplay.getMap();
        if (map) {
            map.once('idle', () => {
                this.mapDisplay.resize();
            });
        }

        // Re-render current shapes
        const shapes = this.stateManager.getAllShapes();
        this.renderShapes(shapes);
    }

    /**
     * Clean up resources
     */
    public destroy(): void {
        this.shape3DRenderer.destroy();
        this.initialized = false;
        logger.info('ShapeRenderer', 'Destroyed');
    }
}
