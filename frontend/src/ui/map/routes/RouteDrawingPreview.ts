import { GeoJSONSource } from 'maplibre-gl';
import { MapDisplay } from '../MapDisplay';
import { StateManager } from '../../../core/StateManager';

/**
 * RouteDrawingPreview - Temporary map sources and layers for the route
 * drawing preview. Owns all MapLibre state associated with the in-progress
 * draw: placed waypoint markers, connecting line, leader line from the
 * anchor (aircraft or last existing waypoint), and the dashed cursor preview.
 *
 * The manager feeds it the current route points and leader anchor; this
 * class doesn't hold the drawing state itself.
 */
export class RouteDrawingPreview {
    private mapDisplay: MapDisplay;
    private stateManager: StateManager;

    constructor(mapDisplay: MapDisplay, stateManager: StateManager) {
        this.mapDisplay = mapDisplay;
        this.stateManager = stateManager;
    }

    /**
     * Set up temporary GeoJSON sources/layers for drawing preview.
     *
     * Layers:
     *  - temp-route-draw-leader: solid line from leader anchor → first waypoint
     *  - temp-route-draw-line:   solid line connecting placed waypoints
     *  - temp-route-draw-preview: dashed line from last waypoint → cursor
     *  - temp-route-draw-points + temp-route-draw-labels: numbered markers
     */
    public setup(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const ensureSource = (id: string) => {
            if (!map.getSource(id)) {
                map.addSource(id, {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: [] }
                });
            }
        };
        ensureSource('temp-route-draw-leader');
        ensureSource('temp-route-draw-line');
        ensureSource('temp-route-draw-preview');
        ensureSource('temp-route-draw-points');

        if (!map.getLayer('temp-route-draw-leader')) {
            map.addLayer({
                id: 'temp-route-draw-leader',
                source: 'temp-route-draw-leader',
                type: 'line',
                paint: {
                    'line-color': '#ffaa00',
                    'line-width': 2,
                    'line-dasharray': [2, 2]
                }
            });
        }
        if (!map.getLayer('temp-route-draw-line')) {
            map.addLayer({
                id: 'temp-route-draw-line',
                source: 'temp-route-draw-line',
                type: 'line',
                paint: {
                    'line-color': '#00aaff',
                    'line-width': 2
                }
            });
        }
        if (!map.getLayer('temp-route-draw-preview')) {
            map.addLayer({
                id: 'temp-route-draw-preview',
                source: 'temp-route-draw-preview',
                type: 'line',
                paint: {
                    'line-color': '#00aaff',
                    'line-width': 2,
                    'line-dasharray': [4, 4],
                    'line-opacity': 1
                }
            });
        }
        if (!map.getLayer('temp-route-draw-points')) {
            map.addLayer({
                id: 'temp-route-draw-points',
                source: 'temp-route-draw-points',
                type: 'circle',
                paint: {
                    'circle-radius': 6,
                    'circle-color': '#00aaff',
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#ffffff'
                }
            });
        }
        if (!map.getLayer('temp-route-draw-labels')) {
            const labelSize = this.stateManager.getState().displayOptions.mapLabelsTextSize;
            map.addLayer({
                id: 'temp-route-draw-labels',
                source: 'temp-route-draw-points',
                type: 'symbol',
                layout: {
                    'text-field': ['get', 'label'],
                    'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
                    'text-size': labelSize,
                    'text-offset': [0, -1.4],
                    'text-anchor': 'bottom'
                },
                paint: {
                    'text-color': '#ffffff',
                    'text-halo-color': '#000000',
                    'text-halo-width': 1.2
                }
            });
        }
    }

    /**
     * Update placed waypoint markers, connecting line, and leader line.
     */
    public updateDrawing(
        routePoints: Array<{ lat: number; lng: number }>,
        leaderAnchor: { lat: number; lng: number } | null
    ): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const pointFeatures = routePoints.map((p, i) => ({
            type: 'Feature' as const,
            geometry: {
                type: 'Point' as const,
                coordinates: [p.lng, p.lat]
            },
            properties: {
                index: i,
                label: `WP${i + 1}`
            }
        }));
        const pointSource = map.getSource('temp-route-draw-points') as GeoJSONSource | undefined;
        if (pointSource) {
            pointSource.setData({ type: 'FeatureCollection', features: pointFeatures });
        }

        const lineSource = map.getSource('temp-route-draw-line') as GeoJSONSource | undefined;
        if (lineSource) {
            if (routePoints.length >= 2) {
                const coords = routePoints.map(p => [p.lng, p.lat]);
                lineSource.setData({
                    type: 'FeatureCollection',
                    features: [
                        {
                            type: 'Feature',
                            geometry: { type: 'LineString', coordinates: coords },
                            properties: {}
                        }
                    ]
                });
            } else {
                lineSource.setData({ type: 'FeatureCollection', features: [] });
            }
        }

        const leaderSource = map.getSource('temp-route-draw-leader') as GeoJSONSource | undefined;
        if (leaderSource) {
            if (leaderAnchor && routePoints.length >= 1) {
                const first = routePoints[0];
                leaderSource.setData({
                    type: 'FeatureCollection',
                    features: [
                        {
                            type: 'Feature',
                            geometry: {
                                type: 'LineString',
                                coordinates: [
                                    [leaderAnchor.lng, leaderAnchor.lat],
                                    [first.lng, first.lat]
                                ]
                            },
                            properties: {}
                        }
                    ]
                });
            } else {
                leaderSource.setData({ type: 'FeatureCollection', features: [] });
            }
        }
    }

    /**
     * Update the dashed preview segment.
     * - No waypoints placed yet: preview runs from the leader anchor → cursor
     *   so the user can see where their first waypoint will attach.
     * - Otherwise: preview runs from the last placed waypoint → cursor.
     */
    public updateCursor(
        cursor: { lat: number; lng: number },
        routePoints: Array<{ lat: number; lng: number }>,
        leaderAnchor: { lat: number; lng: number } | null
    ): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const previewSource = map.getSource('temp-route-draw-preview') as GeoJSONSource | undefined;
        if (!previewSource) return;

        let start: { lat: number; lng: number } | null = null;
        if (routePoints.length > 0) {
            start = routePoints[routePoints.length - 1];
        } else if (leaderAnchor) {
            start = leaderAnchor;
        }

        if (!start) {
            previewSource.setData({ type: 'FeatureCollection', features: [] });
            return;
        }

        previewSource.setData({
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    geometry: {
                        type: 'LineString',
                        coordinates: [
                            [start.lng, start.lat],
                            [cursor.lng, cursor.lat]
                        ]
                    },
                    properties: {}
                }
            ]
        });
    }

    public clear(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const sources = [
            'temp-route-draw-leader',
            'temp-route-draw-points',
            'temp-route-draw-line',
            'temp-route-draw-preview'
        ];
        sources.forEach(id => {
            const src = map.getSource(id) as GeoJSONSource | undefined;
            if (src) {
                src.setData({ type: 'FeatureCollection', features: [] });
            }
        });
    }

    public teardown(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const layers = [
            'temp-route-draw-labels',
            'temp-route-draw-points',
            'temp-route-draw-preview',
            'temp-route-draw-line',
            'temp-route-draw-leader'
        ];
        layers.forEach(id => {
            if (map.getLayer(id)) map.removeLayer(id);
        });

        const sources = [
            'temp-route-draw-leader',
            'temp-route-draw-points',
            'temp-route-draw-line',
            'temp-route-draw-preview'
        ];
        sources.forEach(id => {
            if (map.getSource(id)) map.removeSource(id);
        });
    }
}
