import { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import { Shape, PolygonShape, PolylineShape, DisplayOptions } from '../../../data/types';
import type { MapDisplay } from '../MapDisplay';
import type { StateManager } from '../../../core/StateManager';
import { logger } from '../../../utils/Logger';

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

        // Add sources
        if (!map.getSource(this.POLYGON_SOURCE_ID)) {
            map.addSource(this.POLYGON_SOURCE_ID, {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: []
                }
            });
        }

        if (!map.getSource(this.POLYLINE_SOURCE_ID)) {
            map.addSource(this.POLYLINE_SOURCE_ID, {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: []
                }
            });
        }

        if (!map.getSource(this.LABELS_SOURCE_ID)) {
            map.addSource(this.LABELS_SOURCE_ID, {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: []
                }
            });
        }

        // Get current display options
        const displayOptions = this.stateManager.getDisplayOptions();

        // Add polygon fill layer
        if (!map.getLayer(this.POLYGON_FILL_LAYER_ID)) {
            map.addLayer({
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
        }

        // Add polygon outline layer
        if (!map.getLayer(this.POLYGON_LINE_LAYER_ID)) {
            map.addLayer({
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
        }

        // Add polyline layer
        if (!map.getLayer(this.POLYLINE_LAYER_ID)) {
            map.addLayer({
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
        }

        // Add labels layer
        if (!map.getLayer(this.LABELS_LAYER_ID)) {
            map.addLayer({
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
        }

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

        // Render polygons
        this.renderPolygons(polygons);

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

        // Convert polygons to GeoJSON features
        const features = polygons.map(poly => {
            // Close the polygon ring
            const coordinates = poly.coordinates.map(c => [c.lng, c.lat]);
            coordinates.push(coordinates[0]);

            return {
                type: 'Feature' as const,
                geometry: {
                    type: 'Polygon' as const,
                    coordinates: [coordinates]
                },
                properties: {
                    name: poly.name,
                    fillColor: poly.fillColor || displayOptions.shapeFillColor || '#ff00ff',
                    fillOpacity: poly.fillOpacity !== undefined ? poly.fillOpacity : 0.2,
                    strokeColor: poly.strokeColor || displayOptions.shapeLinesColor || '#ff00ff',
                    strokeWidth: poly.strokeWidth || 2,
                    topAltitude: poly.topAltitude,
                    bottomAltitude: poly.bottomAltitude
                }
            };
        });

        // Update polygon source
        const source = map.getSource(this.POLYGON_SOURCE_ID) as GeoJSONSource;
        if (source) {
            source.setData({
                type: 'FeatureCollection',
                features
            });
        } else {
            logger.warn('ShapeRenderer', `Polygon source '${this.POLYGON_SOURCE_ID}' not found - cannot render ${polygons.length} polygons`);
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
        const features = polylines.map(line => {
            const coordinates = line.coordinates.map(c => [c.lng, c.lat]);

            return {
                type: 'Feature' as const,
                geometry: {
                    type: 'LineString' as const,
                    coordinates
                },
                properties: {
                    name: line.name,
                    color: line.color || displayOptions.shapeLinesColor || '#ff00ff',
                    width: line.width || 2
                }
            };
        });

        // Update polyline source
        const source = map.getSource(this.POLYLINE_SOURCE_ID) as GeoJSONSource;
        if (source) {
            source.setData({
                type: 'FeatureCollection',
                features
            });
        } else {
            logger.warn('ShapeRenderer', `Polyline source '${this.POLYLINE_SOURCE_ID}' not found - cannot render ${polylines.length} polylines`);
        }
    }

    /**
     * Render shape labels
     */
    private renderLabels(shapes: Map<string, Shape>): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        // Create label features at shape centroids
        const features: any[] = [];

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

            features.push({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: centroid
                },
                properties: {
                    name: shape.name
                }
            });
        });

        // Update labels source
        const source = map.getSource(this.LABELS_SOURCE_ID) as GeoJSONSource;
        if (source) {
            source.setData({
                type: 'FeatureCollection',
                features
            });
        } else {
            logger.warn('ShapeRenderer', `Labels source '${this.LABELS_SOURCE_ID}' not found - cannot render labels`);
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
        if (map.getLayer(this.POLYGON_FILL_LAYER_ID)) {
            map.setLayoutProperty(
                this.POLYGON_FILL_LAYER_ID,
                'visibility',
                (displayOptions.showShapes && displayOptions.showShapeFill) ? 'visible' : 'none'
            );
        }

        if (map.getLayer(this.POLYGON_LINE_LAYER_ID)) {
            map.setLayoutProperty(
                this.POLYGON_LINE_LAYER_ID,
                'visibility',
                (displayOptions.showShapes && displayOptions.showShapeLines) ? 'visible' : 'none'
            );
        }

        if (map.getLayer(this.POLYLINE_LAYER_ID)) {
            map.setLayoutProperty(
                this.POLYLINE_LAYER_ID,
                'visibility',
                (displayOptions.showShapes && displayOptions.showShapeLines) ? 'visible' : 'none'
            );
        }

        if (map.getLayer(this.LABELS_LAYER_ID)) {
            map.setLayoutProperty(
                this.LABELS_LAYER_ID,
                'visibility',
                (displayOptions.showShapes && displayOptions.showShapeLabels) ? 'visible' : 'none'
            );

            // Update label color
            map.setPaintProperty(
                this.LABELS_LAYER_ID,
                'text-color',
                displayOptions.shapeLabelsColor || '#ff00ff'
            );
        }

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

        // Re-render current shapes
        const shapes = this.stateManager.getAllShapes();
        this.renderShapes(shapes);
    }

    /**
     * Clean up resources
     */
    public destroy(): void {
        this.initialized = false;
        logger.info('ShapeRenderer', 'Destroyed');
    }
}
