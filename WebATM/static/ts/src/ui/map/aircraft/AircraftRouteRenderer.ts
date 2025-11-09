import { Map, GeoJSONSource } from 'maplibre-gl';
import { RouteData, DisplayOptions } from '../../../data/types';
import { DataProcessor } from '../../../data/DataProcessor';
import { logger } from '../../../utils/Logger';

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
        const emptyFeatureCollection = {
            type: 'FeatureCollection' as const,
            features: []
        };

        // Complete route source
        if (!this.map.getSource(this.SOURCE_ROUTE_COMPLETE)) {
            this.map.addSource(this.SOURCE_ROUTE_COMPLETE, {
                type: 'geojson',
                data: emptyFeatureCollection
            });
        }

        // Aircraft-to-active waypoint source
        if (!this.map.getSource(this.SOURCE_AIRCRAFT_TO_ACTIVE)) {
            this.map.addSource(this.SOURCE_AIRCRAFT_TO_ACTIVE, {
                type: 'geojson',
                data: emptyFeatureCollection
            });
        }

        // Remaining route source
        if (!this.map.getSource(this.SOURCE_ROUTE_REMAINING)) {
            this.map.addSource(this.SOURCE_ROUTE_REMAINING, {
                type: 'geojson',
                data: emptyFeatureCollection
            });
        }

        // Waypoints source
        if (!this.map.getSource(this.SOURCE_ROUTE_WAYPOINTS)) {
            this.map.addSource(this.SOURCE_ROUTE_WAYPOINTS, {
                type: 'geojson',
                data: emptyFeatureCollection
            });
        }

        // Labels source
        if (!this.map.getSource(this.SOURCE_ROUTE_LABELS)) {
            this.map.addSource(this.SOURCE_ROUTE_LABELS, {
                type: 'geojson',
                data: emptyFeatureCollection
            });
        }
    }

    /**
     * Set up route visualization layers
     */
    private setupRouteLayers(): void {
        // Complete route layer (grey dashed line for entire route)
        if (!this.map.getLayer(this.LAYER_ROUTE_COMPLETE)) {
            this.map.addLayer({
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
        }

        // Aircraft-to-active waypoint layer (solid line)
        if (!this.map.getLayer(this.LAYER_AIRCRAFT_TO_ACTIVE)) {
            this.map.addLayer({
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
        }

        // Remaining route layer (dashed line from active waypoint to end)
        if (!this.map.getLayer(this.LAYER_ROUTE_REMAINING)) {
            this.map.addLayer({
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
        }

        // Waypoints layer (circles)
        if (!this.map.getLayer(this.LAYER_ROUTE_WAYPOINTS)) {
            this.map.addLayer({
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
        }

        // Labels layer (text)
        if (!this.map.getLayer(this.LAYER_ROUTE_LABELS)) {
            this.map.addLayer({
                id: this.LAYER_ROUTE_LABELS,
                source: this.SOURCE_ROUTE_LABELS,
                type: 'symbol',
                layout: {
                    'text-field': ['get', 'name'],
                    'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
                    'text-offset': [0, 0],
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
    }

    /**
     * Build GeoJSON features for route visualization
     * @param data - Route data from server
     * @param activeWaypointIndex - Index of active waypoint
     * @returns Object containing all feature collections
     */
    public buildRouteFeatures(data: RouteData, activeWaypointIndex: number) {
        const completeRouteFeatures: any[] = [];
        const aircraftToActiveFeatures: any[] = [];
        const remainingRouteFeatures: any[] = [];
        const waypointFeatures: any[] = [];
        const labelFeatures: any[] = [];

        // Create aircraft-to-active waypoint line
        if (data.aclat !== undefined && data.aclon !== undefined &&
            activeWaypointIndex < data.wplat.length) {

            const activeLat = data.wplat[activeWaypointIndex];
            const activeLon = data.wplon[activeWaypointIndex];

            if (this.isValidCoordinate(activeLat, activeLon)) {
                aircraftToActiveFeatures.push({
                    type: 'Feature',
                    geometry: {
                        type: 'LineString',
                        coordinates: [[data.aclon, data.aclat], [activeLon, activeLat]]
                    },
                    properties: {
                        aircraftId: data.acid
                    }
                });
            }
        }

        // Add all waypoint-to-waypoint connections (complete route)
        for (let i = 0; i < data.wplat.length - 1; i++) {
            const lat1 = data.wplat[i];
            const lon1 = data.wplon[i];
            const lat2 = data.wplat[i + 1];
            const lon2 = data.wplon[i + 1];

            if (this.isValidCoordinate(lat1, lon1) && this.isValidCoordinate(lat2, lon2)) {
                completeRouteFeatures.push({
                    type: 'Feature',
                    geometry: {
                        type: 'LineString',
                        coordinates: [[lon1, lat1], [lon2, lat2]]
                    },
                    properties: {
                        aircraftId: data.acid
                    }
                });
            }
        }

        // Create remaining route line (from active waypoint forward)
        const remainingCoordinates: [number, number][] = [];
        const startIndex = Math.max(0, activeWaypointIndex);

        for (let i = startIndex; i < data.wplat.length; i++) {
            const lat = data.wplat[i];
            const lon = data.wplon[i];

            if (this.isValidCoordinate(lat, lon)) {
                remainingCoordinates.push([lon, lat]);
            }
        }

        if (remainingCoordinates.length >= 2) {
            remainingRouteFeatures.push({
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: remainingCoordinates
                },
                properties: {
                    aircraftId: data.acid
                }
            });
        }

        // Create array of all waypoint coordinates for label positioning
        const allWaypoints: ([number, number] | null)[] = [];
        for (let i = 0; i < data.wplat.length; i++) {
            const lat = data.wplat[i];
            const lon = data.wplon[i];

            if (this.isValidCoordinate(lat, lon)) {
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

            if (!this.isValidCoordinate(lat, lon)) continue;

            const isPassed = i < activeWaypointIndex;
            const isActive = i === activeWaypointIndex;

            // Create waypoint marker
            waypointFeatures.push({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [lon, lat]
                },
                properties: {
                    name: name,
                    isActive: isActive,
                    isPassed: isPassed
                }
            });

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

            // Calculate optimal label position
            const labelPosition = this.calculateOptimalLabelPosition(i, allWaypoints, [lon, lat]);

            labelFeatures.push({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: labelPosition.coordinates
                },
                properties: {
                    name: labelText,
                    anchor: labelPosition.anchor,
                    isPassed: isPassed
                }
            });
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
     * Calculate optimal label position to avoid route line intersection
     */
    private calculateOptimalLabelPosition(
        waypointIndex: number,
        waypoints: ([number, number] | null)[],
        baseCoordinate: [number, number]
    ): { coordinates: [number, number]; anchor: string } {
        // Default position (centered on waypoint)
        let anchor = 'center';
        let offsetLon = 0;
        let offsetLat = 0;

        const [baseLon, baseLat] = baseCoordinate;

        // Calculate offset based on route direction
        const prevWaypoint = waypointIndex > 0 ? waypoints[waypointIndex - 1] : null;
        const nextWaypoint = waypointIndex < waypoints.length - 1 ? waypoints[waypointIndex + 1] : null;

        if (prevWaypoint && nextWaypoint) {
            // Middle waypoint - offset perpendicular to route
            const [prevLon, prevLat] = prevWaypoint;
            const [nextLon, nextLat] = nextWaypoint;

            // Calculate route direction angle
            const dx = nextLon - prevLon;
            const dy = nextLat - prevLat;
            const angle = Math.atan2(dy, dx);

            // Offset perpendicular to route (90 degrees)
            const perpAngle = angle + Math.PI / 2;
            const offsetDistance = 0.015; // Small offset in degrees

            offsetLon = Math.cos(perpAngle) * offsetDistance;
            offsetLat = Math.sin(perpAngle) * offsetDistance;

            // Determine anchor based on offset direction
            if (offsetLat > 0) {
                anchor = 'bottom';
            } else {
                anchor = 'top';
            }
        } else if (prevWaypoint) {
            // Last waypoint - offset away from previous
            anchor = 'left';
            offsetLon = 0.02;
        } else if (nextWaypoint) {
            // First waypoint - offset away from next
            anchor = 'right';
            offsetLon = -0.02;
        }

        const labelLon = baseLon + offsetLon;
        const labelLat = baseLat + offsetLat;

        return {
            coordinates: [labelLon, labelLat],
            anchor: anchor
        };
    }

    /**
     * Update map sources with route features
     */
    public updateMapSources(features: any, showLabels: boolean): void {
        const {
            completeRouteFeatures,
            aircraftToActiveFeatures,
            remainingRouteFeatures,
            waypointFeatures,
            labelFeatures
        } = features;

        // Update complete route
        const completeSource = this.map.getSource(this.SOURCE_ROUTE_COMPLETE) as GeoJSONSource;
        if (completeSource) {
            completeSource.setData({
                type: 'FeatureCollection',
                features: completeRouteFeatures
            });
        }

        // Update aircraft-to-active
        const aircraftToActiveSource = this.map.getSource(this.SOURCE_AIRCRAFT_TO_ACTIVE) as GeoJSONSource;
        if (aircraftToActiveSource) {
            aircraftToActiveSource.setData({
                type: 'FeatureCollection',
                features: aircraftToActiveFeatures
            });
        }

        // Update remaining route
        const remainingSource = this.map.getSource(this.SOURCE_ROUTE_REMAINING) as GeoJSONSource;
        if (remainingSource) {
            remainingSource.setData({
                type: 'FeatureCollection',
                features: remainingRouteFeatures
            });
        }

        // Update waypoints
        const waypointsSource = this.map.getSource(this.SOURCE_ROUTE_WAYPOINTS) as GeoJSONSource;
        if (waypointsSource) {
            waypointsSource.setData({
                type: 'FeatureCollection',
                features: waypointFeatures
            });
        }

        // Update labels (only if labels are enabled)
        const labelsSource = this.map.getSource(this.SOURCE_ROUTE_LABELS) as GeoJSONSource;
        if (labelsSource) {
            const labelsToShow = showLabels ? labelFeatures : [];
            labelsSource.setData({
                type: 'FeatureCollection',
                features: labelsToShow
            });
        }
    }

    /**
     * Clear all route display from map
     */
    public clearRouteDisplay(): void {
        const emptyFeatureCollection = {
            type: 'FeatureCollection' as const,
            features: []
        };

        const completeSource = this.map.getSource(this.SOURCE_ROUTE_COMPLETE) as GeoJSONSource;
        if (completeSource) {
            completeSource.setData(emptyFeatureCollection);
        }

        const aircraftToActiveSource = this.map.getSource(this.SOURCE_AIRCRAFT_TO_ACTIVE) as GeoJSONSource;
        if (aircraftToActiveSource) {
            aircraftToActiveSource.setData(emptyFeatureCollection);
        }

        const remainingSource = this.map.getSource(this.SOURCE_ROUTE_REMAINING) as GeoJSONSource;
        if (remainingSource) {
            remainingSource.setData(emptyFeatureCollection);
        }

        const waypointsSource = this.map.getSource(this.SOURCE_ROUTE_WAYPOINTS) as GeoJSONSource;
        if (waypointsSource) {
            waypointsSource.setData(emptyFeatureCollection);
        }

        const labelsSource = this.map.getSource(this.SOURCE_ROUTE_LABELS) as GeoJSONSource;
        if (labelsSource) {
            labelsSource.setData(emptyFeatureCollection);
        }
    }

    /**
     * Update route lines visibility
     */
    public updateRouteLinesVisibility(showRoutes: boolean, showRouteLines: boolean): void {
        const shouldShow = showRoutes && showRouteLines;
        const visibility = shouldShow ? 'visible' : 'none';

        if (this.map.getLayer(this.LAYER_ROUTE_COMPLETE)) {
            this.map.setLayoutProperty(this.LAYER_ROUTE_COMPLETE, 'visibility', visibility);
        }
        if (this.map.getLayer(this.LAYER_AIRCRAFT_TO_ACTIVE)) {
            this.map.setLayoutProperty(this.LAYER_AIRCRAFT_TO_ACTIVE, 'visibility', visibility);
        }
        if (this.map.getLayer(this.LAYER_ROUTE_REMAINING)) {
            this.map.setLayoutProperty(this.LAYER_ROUTE_REMAINING, 'visibility', visibility);
        }
    }

    /**
     * Update route labels visibility
     */
    public updateRouteLabelsVisibility(showRoutes: boolean, showRouteLabels: boolean): void {
        const shouldShow = showRoutes && showRouteLabels;
        if (this.map.getLayer(this.LAYER_ROUTE_LABELS)) {
            this.map.setLayoutProperty(this.LAYER_ROUTE_LABELS, 'visibility',
                shouldShow ? 'visible' : 'none');
        }
    }

    /**
     * Update route points visibility
     */
    public updateRoutePointsVisibility(showRoutes: boolean, showRoutePoints: boolean): void {
        const shouldShow = showRoutes && showRoutePoints;
        if (this.map.getLayer(this.LAYER_ROUTE_WAYPOINTS)) {
            this.map.setLayoutProperty(this.LAYER_ROUTE_WAYPOINTS, 'visibility',
                shouldShow ? 'visible' : 'none');
        }
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
        // Convert meters to feet (DataProcessor expects feet)
        const altFeet = altMeters / 0.3048;

        // Use DataProcessor for consistent formatting
        return DataProcessor.formatAltitude(altFeet, this.displayOptions.altitudeUnit);
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

    /**
     * Validate coordinate values
     */
    private isValidCoordinate(lat: number, lon: number): boolean {
        return typeof lat === 'number' && typeof lon === 'number' &&
               !isNaN(lat) && !isNaN(lon) &&
               lat >= -90 && lat <= 90 &&
               lon >= -180 && lon <= 180;
    }
}
