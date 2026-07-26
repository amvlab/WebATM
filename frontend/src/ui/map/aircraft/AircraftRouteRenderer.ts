import { Map, ExpressionSpecification } from 'maplibre-gl';
import { RouteData, DisplayOptions } from '../../../data/types';
import { DataProcessor } from '../../../data/DataProcessor';
import { lineStringFeature, pointFeature } from '../../../utils/geojson';
import { logger } from '../../../utils/Logger';
import {
    ensureGeoJSONSource,
    ensureLayer,
    updateSourceFeatures,
    setLayerVisibility,
    isValidCoordinate
} from '../../../utils/maplibre';

/**
 * GeoJSON feature collections produced by buildRouteFeatures and consumed
 * by updateMapSources, one array per route map source.
 */
export interface RouteFeatureSets {
    completeRouteFeatures: GeoJSON.Feature[];
    aircraftToActiveFeatures: GeoJSON.Feature[];
    remainingRouteFeatures: GeoJSON.Feature[];
    waypointFeatures: GeoJSON.Feature[];
    labelFeatures: GeoJSON.Feature[];
}

/**
 * AircraftRouteRenderer - MapLibre rendering for aircraft routes: layer and
 * source management, GeoJSON feature building, waypoint label placement and
 * constraint formatting. Separated from AircraftRoutes to keep rendering
 * concerns isolated.
 */
export class AircraftRouteRenderer {
    private map: Map;
    private displayOptions: DisplayOptions;

    // Each route source feeds exactly one layer, so they share an id.
    private readonly ROUTE_COMPLETE = 'route-complete';
    private readonly AIRCRAFT_TO_ACTIVE = 'aircraft-to-active';
    private readonly ROUTE_REMAINING = 'route-remaining';
    private readonly ROUTE_WAYPOINTS = 'route-waypoints';
    private readonly ROUTE_LABELS = 'route-labels';
    private readonly ALL_SOURCES = [
        this.ROUTE_COMPLETE,
        this.AIRCRAFT_TO_ACTIVE,
        this.ROUTE_REMAINING,
        this.ROUTE_WAYPOINTS,
        this.ROUTE_LABELS
    ];

    constructor(map: Map, displayOptions: DisplayOptions) {
        this.map = map;
        this.displayOptions = displayOptions;
    }

    /**
     * Set up route sources and layers on the map.
     * Should be called after map style loads or changes.
     */
    public setupLayers(): void {
        if (!this.map) return;

        for (const id of this.ALL_SOURCES) {
            ensureGeoJSONSource(this.map, id);
        }
        this.setupRouteLayers();

        logger.debug('AircraftRouteRenderer', 'Aircraft route layers set up');
    }

    private setupRouteLayers(): void {
        // Complete route (grey dashed line over the entire route)
        ensureLayer(this.map, {
            id: this.ROUTE_COMPLETE,
            source: this.ROUTE_COMPLETE,
            type: 'line',
            layout: {
                'line-join': 'round',
                'line-cap': 'round'
            },
            paint: {
                'line-color': '#888888',
                'line-width': 2,
                'line-opacity': 0.6,
                'line-dasharray': [3, 3]
            }
        });

        // Aircraft-to-active waypoint (solid line)
        ensureLayer(this.map, {
            id: this.AIRCRAFT_TO_ACTIVE,
            source: this.AIRCRAFT_TO_ACTIVE,
            type: 'line',
            layout: {
                'line-join': 'round',
                'line-cap': 'round'
            },
            paint: {
                'line-color': this.displayOptions.routeLinesColor,
                'line-width': 3,
                'line-opacity': 0.8
            }
        });

        // Remaining route (dashed line from active waypoint to end)
        ensureLayer(this.map, {
            id: this.ROUTE_REMAINING,
            source: this.ROUTE_REMAINING,
            type: 'line',
            layout: {
                'line-join': 'round',
                'line-cap': 'round'
            },
            paint: {
                'line-color': this.displayOptions.routeLinesColor,
                'line-width': 3,
                'line-opacity': 0.8,
                'line-dasharray': [2, 2]
            }
        });

        // Waypoint circles
        ensureLayer(this.map, {
            id: this.ROUTE_WAYPOINTS,
            source: this.ROUTE_WAYPOINTS,
            type: 'circle',
            paint: {
                'circle-radius': [
                    'case',
                    ['get', 'isActive'],
                    8,
                    6
                ],
                'circle-color': this.waypointColorExpr(this.displayOptions.routePointsColor),
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2,
                'circle-opacity': [
                    'case',
                    ['get', 'isPassed'],
                    0.5,
                    0.9
                ]
            }
        });

        // Waypoint labels
        ensureLayer(this.map, {
            id: this.ROUTE_LABELS,
            source: this.ROUTE_LABELS,
            type: 'symbol',
            layout: {
                'text-field': ['get', 'name'],
                'text-font': ['Open Sans Regular'],
                'text-offset': ['get', 'offset'],
                'text-anchor': ['get', 'anchor'],
                'text-size': this.displayOptions.mapLabelsTextSize,
                'text-allow-overlap': false,
                'text-ignore-placement': false
            },
            paint: {
                'text-color': this.displayOptions.routeLabelsColor,
                'text-halo-color': '#ffffff',
                'text-halo-width': 1
            }
        });
    }

    /** Circle color: grey when passed, green when active, else the configured color. */
    private waypointColorExpr(routePointsColor: string): ExpressionSpecification {
        return [
            'case',
            ['get', 'isPassed'],
            '#888888',
            ['get', 'isActive'],
            '#00ff00',
            routePointsColor
        ];
    }

    /**
     * Build GeoJSON features for route visualization
     * @param data - Route data from server
     * @param activeWaypointIndex - Index of active waypoint
     * @returns Object containing all feature collections
     */
    public buildRouteFeatures(data: RouteData, activeWaypointIndex: number): RouteFeatureSets {
        const completeRouteFeatures: GeoJSON.Feature[] = [];
        const aircraftToActiveFeatures: GeoJSON.Feature[] = [];
        const remainingRouteFeatures: GeoJSON.Feature[] = [];
        const waypointFeatures: GeoJSON.Feature[] = [];
        const labelFeatures: GeoJSON.Feature[] = [];

        // Aircraft-to-active waypoint line
        if (isValidCoordinate(data.aclat, data.aclon) &&
            activeWaypointIndex < data.wplat.length) {

            const activeLat = data.wplat[activeWaypointIndex];
            const activeLon = data.wplon[activeWaypointIndex];

            if (isValidCoordinate(activeLat, activeLon)) {
                aircraftToActiveFeatures.push(lineStringFeature(
                    [[data.aclon, data.aclat], [activeLon, activeLat]],
                    { aircraftId: data.acid }
                ));
            }
        }

        // Complete route: one segment per waypoint-to-waypoint connection
        for (let i = 0; i < data.wplat.length - 1; i++) {
            const lat1 = data.wplat[i];
            const lon1 = data.wplon[i];
            const lat2 = data.wplat[i + 1];
            const lon2 = data.wplon[i + 1];

            if (isValidCoordinate(lat1, lon1) && isValidCoordinate(lat2, lon2)) {
                completeRouteFeatures.push(lineStringFeature(
                    [[lon1, lat1], [lon2, lat2]],
                    { aircraftId: data.acid }
                ));
            }
        }

        // Remaining route line (from active waypoint forward)
        const remainingCoordinates: [number, number][] = [];
        for (let i = Math.max(0, activeWaypointIndex); i < data.wplat.length; i++) {
            if (isValidCoordinate(data.wplat[i], data.wplon[i])) {
                remainingCoordinates.push([data.wplon[i], data.wplat[i]]);
            }
        }
        if (remainingCoordinates.length >= 2) {
            remainingRouteFeatures.push(lineStringFeature(
                remainingCoordinates,
                { aircraftId: data.acid }
            ));
        }

        // All waypoint coordinates (invalid ones as null), for label positioning
        const allWaypoints = data.wplat.map((lat, i): [number, number] | null =>
            isValidCoordinate(lat, data.wplon[i]) ? [data.wplon[i], lat] : null);

        // Waypoint markers and labels
        for (let i = 0; i < data.wplat.length; i++) {
            const lat = data.wplat[i];
            const lon = data.wplon[i];
            const name = data.wpname[i] || `WP${i + 1}`;

            if (!isValidCoordinate(lat, lon)) continue;

            const isPassed = i < activeWaypointIndex;
            const isActive = i === activeWaypointIndex;

            waypointFeatures.push(pointFeature([lon, lat], {
                name: name,
                isActive: isActive,
                isPassed: isPassed
            }));

            // Label text: waypoint name plus any altitude/speed constraints
            // (BlueSky marks "no constraint" with values <= 0)
            let labelText = name;
            const constraints: string[] = [];
            const alt = data.wpalt?.[i] ?? 0;
            const spd = data.wpspd?.[i] ?? 0;
            if (alt > 0) constraints.push(this.formatAltitudeValue(alt));
            if (spd > 0) constraints.push(this.formatSpeedValue(spd));
            if (constraints.length > 0) {
                labelText += '\n' + constraints.join(' ');
            }

            const labelPosition = this.calculateOptimalLabelPosition(i, allWaypoints);

            labelFeatures.push(pointFeature([lon, lat], {
                name: labelText,
                anchor: labelPosition.anchor,
                offset: labelPosition.offset,
                isPassed: isPassed
            }));
        }

        return {
            completeRouteFeatures,
            aircraftToActiveFeatures,
            remainingRouteFeatures,
            waypointFeatures,
            labelFeatures
        };
    }

    /**
     * Pick label anchor + em-based offset so the label sits just off the
     * waypoint without intersecting the route line. Using an em-offset on
     * the layer (instead of shifting the geographic coordinate) keeps the
     * pixel gap between circle and label constant across zoom levels.
     *
     * MapLibre text-offset units are em's of the text size, with +X=right,
     * +Y=down. The anchor names the edge of the label that sits at the
     * offset point, so it must face back toward the waypoint — otherwise
     * the label body extends across the route line instead of away from it.
     */
    private calculateOptimalLabelPosition(
        waypointIndex: number,
        waypoints: ([number, number] | null)[]
    ): { anchor: string; offset: [number, number] } {
        const prevWaypoint = waypointIndex > 0 ? waypoints[waypointIndex - 1] : null;
        const nextWaypoint = waypointIndex < waypoints.length - 1 ? waypoints[waypointIndex + 1] : null;

        if (prevWaypoint && nextWaypoint) {
            // Middle waypoint — offset perpendicular to the route direction,
            // flipped if needed so it always biases upward (north).
            const [prevLon, prevLat] = prevWaypoint;
            const [nextLon, nextLat] = nextWaypoint;
            const angle = Math.atan2(nextLat - prevLat, nextLon - prevLon);
            const perpX = Math.cos(angle + Math.PI / 2);
            const perpY = Math.sin(angle + Math.PI / 2);
            const signY = perpY >= 0 ? 1 : -1;
            const geoOffX = perpX * signY;
            const geoOffY = perpY * signY; // >= 0 after the flip

            // Screen em offset: +x = east = screen right; screen Y is
            // inverted relative to geographic north.
            const emRadius = 1.1;
            const offset: [number, number] = [geoOffX * emRadius, -geoOffY * emRadius];

            // Anchor the label edge nearest the waypoint. For mostly-
            // horizontal offsets (near-vertical route segments) that must be
            // a side edge — a top/bottom anchor keeps the label horizontally
            // centered on the waypoint, laying it across the route line.
            const anchor = Math.abs(geoOffX) > geoOffY
                ? (geoOffX > 0 ? 'left' : 'right')
                : 'bottom';
            return { anchor, offset };
        }
        if (prevWaypoint) {
            // Last waypoint — label to the right of the point
            return { anchor: 'left', offset: [0.8, 0] };
        }
        if (nextWaypoint) {
            // First waypoint — label to the left of the point
            return { anchor: 'right', offset: [-0.8, 0] };
        }
        // Isolated waypoint — label above the point
        return { anchor: 'bottom', offset: [0, -0.8] };
    }

    /**
     * Update map sources with route features
     */
    public updateMapSources(features: RouteFeatureSets, showLabels: boolean): void {
        updateSourceFeatures(this.map, this.ROUTE_COMPLETE, features.completeRouteFeatures);
        updateSourceFeatures(this.map, this.AIRCRAFT_TO_ACTIVE, features.aircraftToActiveFeatures);
        updateSourceFeatures(this.map, this.ROUTE_REMAINING, features.remainingRouteFeatures);
        updateSourceFeatures(this.map, this.ROUTE_WAYPOINTS, features.waypointFeatures);
        updateSourceFeatures(this.map, this.ROUTE_LABELS, showLabels ? features.labelFeatures : []);
    }

    /**
     * Clear all route display from map
     */
    public clearRouteDisplay(): void {
        for (const id of this.ALL_SOURCES) {
            updateSourceFeatures(this.map, id, []);
        }
    }

    public updateRouteLinesVisibility(showRoutes: boolean, showRouteLines: boolean): void {
        const shouldShow = showRoutes && showRouteLines;
        setLayerVisibility(this.map, this.ROUTE_COMPLETE, shouldShow);
        setLayerVisibility(this.map, this.AIRCRAFT_TO_ACTIVE, shouldShow);
        setLayerVisibility(this.map, this.ROUTE_REMAINING, shouldShow);
    }

    public updateRouteLabelsVisibility(showRoutes: boolean, showRouteLabels: boolean): void {
        setLayerVisibility(this.map, this.ROUTE_LABELS, showRoutes && showRouteLabels);
    }

    public updateRoutePointsVisibility(showRoutes: boolean, showRoutePoints: boolean): void {
        setLayerVisibility(this.map, this.ROUTE_WAYPOINTS, showRoutes && showRoutePoints);
    }

    /**
     * Update route colors from display options
     */
    public updateRouteColors(displayOptions: DisplayOptions): void {
        this.displayOptions = displayOptions;

        if (this.map.getLayer(this.ROUTE_LABELS)) {
            this.map.setPaintProperty(this.ROUTE_LABELS, 'text-color',
                displayOptions.routeLabelsColor);
        }
        if (this.map.getLayer(this.ROUTE_WAYPOINTS)) {
            this.map.setPaintProperty(this.ROUTE_WAYPOINTS, 'circle-color',
                this.waypointColorExpr(displayOptions.routePointsColor));
        }
        if (this.map.getLayer(this.AIRCRAFT_TO_ACTIVE)) {
            this.map.setPaintProperty(this.AIRCRAFT_TO_ACTIVE, 'line-color',
                displayOptions.routeLinesColor);
        }
        if (this.map.getLayer(this.ROUTE_REMAINING)) {
            this.map.setPaintProperty(this.ROUTE_REMAINING, 'line-color',
                displayOptions.routeLinesColor);
        }
    }

    /**
     * Update label text size
     */
    public updateLabelSize(size: number): void {
        if (this.map.getLayer(this.ROUTE_LABELS)) {
            this.map.setLayoutProperty(this.ROUTE_LABELS, 'text-size', size);
        }
    }

    /** Format a waypoint altitude constraint (server sends meters). */
    private formatAltitudeValue(altMeters: number): string {
        return DataProcessor.formatAltitude(altMeters, this.displayOptions.altitudeUnit);
    }

    /** Format a waypoint speed constraint (server sends CAS in m/s). */
    private formatSpeedValue(speedMs: number): string {
        const speedKnots = speedMs / 0.514444;
        return DataProcessor.formatSpeed(speedKnots, this.displayOptions.speedUnit);
    }
}
