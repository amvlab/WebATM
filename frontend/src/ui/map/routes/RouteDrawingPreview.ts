import { MapDisplay } from '../MapDisplay';
import { StateManager } from '../../../core/StateManager';
import { lineStringFeature, pointFeature, toLngLatCoords } from '../../../utils/geojson';
import {
    ensureGeoJSONSource,
    ensureLayer,
    safeRemoveLayer,
    safeRemoveSource,
    updateSourceFeatures
} from '../../../utils/maplibre';

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

        ensureGeoJSONSource(map, 'temp-route-draw-leader');
        ensureGeoJSONSource(map, 'temp-route-draw-line');
        ensureGeoJSONSource(map, 'temp-route-draw-preview');
        ensureGeoJSONSource(map, 'temp-route-draw-points');

        ensureLayer(map, {
            id: 'temp-route-draw-leader',
            source: 'temp-route-draw-leader',
            type: 'line',
            paint: {
                'line-color': '#ffaa00',
                'line-width': 2,
                'line-dasharray': [2, 2]
            }
        });
        ensureLayer(map, {
            id: 'temp-route-draw-line',
            source: 'temp-route-draw-line',
            type: 'line',
            paint: {
                'line-color': '#00aaff',
                'line-width': 2
            }
        });
        ensureLayer(map, {
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
        ensureLayer(map, {
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
        const labelSize = this.stateManager.getState().displayOptions.mapLabelsTextSize;
        ensureLayer(map, {
            id: 'temp-route-draw-labels',
            source: 'temp-route-draw-points',
            type: 'symbol',
            layout: {
                'text-field': ['get', 'label'],
                'text-font': ['Open Sans Regular'],
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

    /**
     * Update placed waypoint markers, connecting line, and leader line.
     */
    public updateDrawing(
        routePoints: Array<{ lat: number; lng: number }>,
        leaderAnchor: { lat: number; lng: number } | null
    ): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const pointFeatures = routePoints.map((p, i) =>
            pointFeature([p.lng, p.lat], { index: i, label: `WP${i + 1}` }));
        updateSourceFeatures(map, 'temp-route-draw-points', pointFeatures);

        updateSourceFeatures(
            map,
            'temp-route-draw-line',
            routePoints.length >= 2
                ? [lineStringFeature(toLngLatCoords(routePoints))]
                : []
        );

        updateSourceFeatures(
            map,
            'temp-route-draw-leader',
            leaderAnchor && routePoints.length >= 1
                ? [lineStringFeature(toLngLatCoords([leaderAnchor, routePoints[0]]))]
                : []
        );
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

        let start: { lat: number; lng: number } | null = null;
        if (routePoints.length > 0) {
            start = routePoints[routePoints.length - 1];
        } else if (leaderAnchor) {
            start = leaderAnchor;
        }

        updateSourceFeatures(
            map,
            'temp-route-draw-preview',
            start ? [lineStringFeature(toLngLatCoords([start, cursor]))] : []
        );
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
        sources.forEach(id => updateSourceFeatures(map, id, []));
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
        layers.forEach(id => safeRemoveLayer(map, id));

        const sources = [
            'temp-route-draw-leader',
            'temp-route-draw-points',
            'temp-route-draw-line',
            'temp-route-draw-preview'
        ];
        sources.forEach(id => safeRemoveSource(map, id));
    }
}
