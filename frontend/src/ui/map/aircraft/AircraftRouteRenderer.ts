import { Map } from 'maplibre-gl';
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
 * AircraftRouteRenderer - Handles MapLibre GL rendering for aircraft routes
 *
 * This class is responsible for all MapLibre-specific rendering logic:
 * - Setting up and managing map layers and sources
 * - Building GeoJSON features from route data
 * - Calculating optimal label positions
 * - Formatting waypoint constraint labels
 *
 * Separated from AircraftRoutes to keep rendering concerns isolated.
 */
export class AircraftRouteRenderer {
    private map: Map;
    private displayOptions: DisplayOptions;

    // MapLibre layer IDs
    private readonly LAYER_ROUTE_COMPLETE = 'route-complete';
    private readonly LAYER_AIRCRAFT_TO_ACTIVE = 'aircraft-to-active';
    private readonly LAYER_ROUTE_REMAINING = 'route-remaining';
    private readonly LAYER_ROUTE_WAYPOINTS = 'route-waypoints';
    private readonly LAYER_ROUTE_LABELS = 'route-labels';

    // MapLibre source IDs
    private readonly SOURCE_ROUTE_COMPLETE = 'route-complete';
    private readonly SOURCE_AIRCRAFT_TO_ACTIVE = 'aircraft-to-active';
    private readonly SOURCE_ROUTE_REMAINING = 'route-remaining';
    private readonly SOURCE_ROUTE_WAYPOINTS = 'route-waypoints';
    private readonly SOURCE_ROUTE_LABELS = 'route-labels';

    /**
     * Constructor
     * @param map - MapLibre GL map instance
     * @param displayOptions - Display options containing colors, units, toggles
     */
    constructor(map: Map, displayOptions: DisplayOptions) {
        this.map = map;
        this.displayOptions = displayOptions;
    }

    /**
     * Set up route layers on the map
     * Should be called after map style loads or changes
     */
    public setupLayers(): void {
        if (!this.map) return;

        // Set up sources
        this.setupSources();

        // Set up layers
        this.setupRouteLayers();

        logger.debug('AircraftRouteRenderer', 'Aircraft route layers set up');
    }

    /**
     * Set up GeoJSON sources for route visualization
     */
    private setupSources(): void {
        ensureGeoJSONSource(this.map, this.SOURCE_ROUTE_COMPLETE);
        ensureGeoJSONSource(this.map, this.SOURCE_AIRCRAFT_TO_ACTIVE);
        ensureGeoJSONSource(this.map, this.SOURCE_ROUTE_REMAINING);
        ensureGeoJSONSource(this.map, this.SOURCE_ROUTE_WAYPOINTS);
        ensureGeoJSONSource(this.map, this.SOURCE_ROUTE_LABELS);
    }

    /**
     * Set up route visualization layers
     */
    private setupRouteLayers(): void {
        // Complete route layer (grey dashed line for entire route)
        ensureLayer(this.map, {
            id: this.LAYER_ROUTE_COMPLETE,
            source: this.SOURCE_ROUTE_COMPLETE,
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

        // Aircraft-to-active waypoint layer (solid line)
        ensureLayer(this.map, {
            id: this.LAYER_AIRCRAFT_TO_ACTIVE,
            source: this.SOURCE_AIRCRAFT_TO_ACTIVE,
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

        // Remaining route layer (dashed line from active waypoint to end)
        ensureLayer(this.map, {
            id: this.LAYER_ROUTE_REMAINING,
            source: this.SOURCE_ROUTE_REMAINING,
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

        // Waypoints layer (circles)
        ensureLayer(this.map, {
            id: this.LAYER_ROUTE_WAYPOINTS,
            source: this.SOURCE_ROUTE_WAYPOINTS,
            type: 'circle',
            paint: {
                'circle-radius': [
                    'case',
                    ['get', 'isActive'],
                    8, // Larger for active waypoint
                    6  // Normal size
                ],
                'circle-color': [
                    'case',
                    ['get', 'isPassed'],
                    '#888888', // Gray for passed waypoints
                    ['get', 'isActive'],
                    '#00ff00', // Green for active waypoint
                    this.displayOptions.routePointsColor  // Custom color for future waypoints
                ],
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2,
                'circle-opacity': [
                    'case',
                    ['get', 'isPassed'],
                    0.5, // Semi-transparent for passed waypoints
                    0.9  // Full opacity for future waypoints
                ]
            }
        });

        // Labels layer (text)
        ensureLayer(this.map, {
            id: this.LAYER_ROUTE_LABELS,
            source: this.SOURCE_ROUTE_LABELS,
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

        // Create aircraft-to-active waypoint line
        if (data.aclat !== undefined && data.aclon !== undefined &&
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

        // Add all waypoint-to-waypoint connections (complete route)
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

        // Create remaining route line (from active waypoint forward)
        const remainingCoordinates: [number, number][] = [];
        const startIndex = Math.max(0, activeWaypointIndex);

        for (let i = startIndex; i < data.wplat.length; i++) {
            const lat = data.wplat[i];
            const lon = data.wplon[i];

            if (isValidCoordinate(lat, lon)) {
                remainingCoordinates.push([lon, lat]);
            }
        }

        if (remainingCoordinates.length >= 2) {
            remainingRouteFeatures.push(lineStringFeature(
                remainingCoordinates,
                { aircraftId: data.acid }
            ));
        }

        // Create array of all waypoint coordinates for label positioning
        const allWaypoints: ([number, number] | null)[] = [];
        for (let i = 0; i < data.wplat.length; i++) {
            const lat = data.wplat[i];
            const lon = data.wplon[i];

            if (isValidCoordinate(lat, lon)) {
                allWaypoints.push([lon, lat]);
            } else {
                allWaypoints.push(null);
            }
        }

        // Create waypoint markers and labels
        for (let i = 0; i < data.wplat.length; i++) {
            const lat = data.wplat[i];
            const lon = data.wplon[i];
            const name = data.wpname[i] || `WP${i + 1}`;

            if (!isValidCoordinate(lat, lon)) continue;

            const isPassed = i < activeWaypointIndex;
            const isActive = i === activeWaypointIndex;

            // Create waypoint marker
            waypointFeatures.push(pointFeature([lon, lat], {
                name: name,
                isActive: isActive,
                isPassed: isPassed
            }));

            // Create waypoint label with constraints
            let labelText = name;

            // Add altitude and speed constraints if available
            if (data.wpalt && data.wpspd && i < data.wpalt.length && i < data.wpspd.length) {
                const alt = data.wpalt[i];
                const spd = data.wpspd[i];

                if (alt > 0 || spd > 0) {
                    const constraints: string[] = [];
                    if (alt > 0) constraints.push(this.formatAltitudeValue(alt));
                    if (spd > 0) constraints.push(this.formatSpeedValue(spd));

                    if (constraints.length > 0) {
                        labelText += '\n' + constraints.join(' ');
                    }
                }
            }

            // Calculate optimal label position (anchor + em-based offset so
            // the label stays visually close to the circle at any zoom level)
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
     * +Y=down. Anchor semantics: the named edge/corner of the label sits
     * at the rendered point; a small offset away from that edge then
     * produces a visible gap from the circle.
     */
    private calculateOptimalLabelPosition(
        waypointIndex: number,
        waypoints: ([number, number] | null)[]
    ): { anchor: string; offset: [number, number] } {
        // Default: label above the waypoint
        let anchor = 'bottom';
        let offset: [number, number] = [0, -0.8];

        const prevWaypoint = waypointIndex > 0 ? waypoints[waypointIndex - 1] : null;
        const nextWaypoint = waypointIndex < waypoints.length - 1 ? waypoints[waypointIndex + 1] : null;

        if (prevWaypoint && nextWaypoint) {
            // Middle waypoint — offset perpendicular to the route direction
            const [prevLon, prevLat] = prevWaypoint;
            const [nextLon, nextLat] = nextWaypoint;

            const dx = nextLon - prevLon;
            const dy = nextLat - prevLat;
            const angle = Math.atan2(dy, dx);

            // Perpendicular direction (rotated 90° counter-clockwise in lng/lat space)
            const perpX = Math.cos(angle + Math.PI / 2);
            const perpY = Math.sin(angle + Math.PI / 2);

            // Keep label above the route (positive lat offset) for readability.
            // perpY > 0 means the perpendicular points "up" in geographic
            // space; flip if needed so we always bias upward.
            const signY = perpY >= 0 ? 1 : -1;
            const geoOffX = perpX * signY;
            const geoOffY = perpY * signY;

            // Convert the geographic direction into a screen-space em offset.
            // Map lng/lat: +x = east (screen right), +y = north (screen up),
            // so screen Y is inverted relative to MapLibre's text-offset Y.
            const emRadius = 1.1; // em's between point and nearest edge of label
            offset = [geoOffX * emRadius, -geoOffY * emRadius];
            anchor = geoOffY > 0 ? 'bottom' : 'top';
        } else if (prevWaypoint) {
            // Last waypoint — label to the right of the point
            anchor = 'left';
            offset = [0.8, 0];
        } else if (nextWaypoint) {
            // First waypoint — label to the left of the point
            anchor = 'right';
            offset = [-0.8, 0];
        }

        return { anchor, offset };
    }

    /**
     * Update map sources with route features
     */
    public updateMapSources(features: RouteFeatureSets, showLabels: boolean): void {
        const {
            completeRouteFeatures,
            aircraftToActiveFeatures,
            remainingRouteFeatures,
            waypointFeatures,
            labelFeatures
        } = features;

        updateSourceFeatures(this.map, this.SOURCE_ROUTE_COMPLETE, completeRouteFeatures);
        updateSourceFeatures(this.map, this.SOURCE_AIRCRAFT_TO_ACTIVE, aircraftToActiveFeatures);
        updateSourceFeatures(this.map, this.SOURCE_ROUTE_REMAINING, remainingRouteFeatures);
        updateSourceFeatures(this.map, this.SOURCE_ROUTE_WAYPOINTS, waypointFeatures);
        updateSourceFeatures(this.map, this.SOURCE_ROUTE_LABELS, showLabels ? labelFeatures : []);
    }

    /**
     * Clear all route display from map
     */
    public clearRouteDisplay(): void {
        updateSourceFeatures(this.map, this.SOURCE_ROUTE_COMPLETE, []);
        updateSourceFeatures(this.map, this.SOURCE_AIRCRAFT_TO_ACTIVE, []);
        updateSourceFeatures(this.map, this.SOURCE_ROUTE_REMAINING, []);
        updateSourceFeatures(this.map, this.SOURCE_ROUTE_WAYPOINTS, []);
        updateSourceFeatures(this.map, this.SOURCE_ROUTE_LABELS, []);
    }

    /**
     * Update route lines visibility
     */
    public updateRouteLinesVisibility(showRoutes: boolean, showRouteLines: boolean): void {
        const shouldShow = showRoutes && showRouteLines;
        setLayerVisibility(this.map, this.LAYER_ROUTE_COMPLETE, shouldShow);
        setLayerVisibility(this.map, this.LAYER_AIRCRAFT_TO_ACTIVE, shouldShow);
        setLayerVisibility(this.map, this.LAYER_ROUTE_REMAINING, shouldShow);
    }

    /**
     * Update route labels visibility
     */
    public updateRouteLabelsVisibility(showRoutes: boolean, showRouteLabels: boolean): void {
        setLayerVisibility(this.map, this.LAYER_ROUTE_LABELS, showRoutes && showRouteLabels);
    }

    /**
     * Update route points visibility
     */
    public updateRoutePointsVisibility(showRoutes: boolean, showRoutePoints: boolean): void {
        setLayerVisibility(this.map, this.LAYER_ROUTE_WAYPOINTS, showRoutes && showRoutePoints);
    }

    /**
     * Update route colors from display options
     */
    public updateRouteColors(displayOptions: DisplayOptions): void {
        this.displayOptions = displayOptions;

        // Update route labels
        if (this.map.getLayer(this.LAYER_ROUTE_LABELS)) {
            this.map.setPaintProperty(this.LAYER_ROUTE_LABELS, 'text-color',
                displayOptions.routeLabelsColor);
        }

        // Update route waypoints
        if (this.map.getLayer(this.LAYER_ROUTE_WAYPOINTS)) {
            this.map.setPaintProperty(this.LAYER_ROUTE_WAYPOINTS, 'circle-color', [
                'case',
                ['get', 'isPassed'],
                '#888888', // Gray for passed waypoints
                ['get', 'isActive'],
                '#00ff00', // Green for active waypoint
                displayOptions.routePointsColor
            ]);
        }

        // Update route lines
        if (this.map.getLayer(this.LAYER_ROUTE_COMPLETE)) {
            this.map.setPaintProperty(this.LAYER_ROUTE_COMPLETE, 'line-color', '#888888');
        }
        if (this.map.getLayer(this.LAYER_AIRCRAFT_TO_ACTIVE)) {
            this.map.setPaintProperty(this.LAYER_AIRCRAFT_TO_ACTIVE, 'line-color',
                displayOptions.routeLinesColor);
        }
        if (this.map.getLayer(this.LAYER_ROUTE_REMAINING)) {
            this.map.setPaintProperty(this.LAYER_ROUTE_REMAINING, 'line-color',
                displayOptions.routeLinesColor);
        }
    }

    /**
     * Update label text size
     */
    public updateLabelSize(size: number): void {
        if (this.map.getLayer(this.LAYER_ROUTE_LABELS)) {
            this.map.setLayoutProperty(this.LAYER_ROUTE_LABELS, 'text-size', size);
        }
    }

    /**
     * Format altitude value according to display options
     * Server sends altitude in METERS
     */
    private formatAltitudeValue(altMeters: number): string {
        // Use DataProcessor for consistent formatting (now expects meters)
        return DataProcessor.formatAltitude(altMeters, this.displayOptions.altitudeUnit);
    }

    /**
     * Format speed value according to display options
     * Server sends speed in M/S (Calibrated Airspeed)
     */
    private formatSpeedValue(speedMs: number): string {
        // Convert m/s to knots (DataProcessor expects knots)
        const speedKnots = speedMs / 0.514444;

        // Use DataProcessor for consistent formatting
        return DataProcessor.formatSpeed(speedKnots, this.displayOptions.speedUnit);
    }

}
