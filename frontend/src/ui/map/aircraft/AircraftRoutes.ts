import { Map } from 'maplibre-gl';
import { RouteData, DisplayOptions } from '../../../data/types';
import { AircraftRouteRenderer } from './AircraftRouteRenderer';
import { clampActiveWaypoint } from '../../../utils/route';
import { logger } from '../../../utils/Logger';

/**
 * AircraftRoutes - Manages aircraft route visualization on the map
 *
 * Holds the route data and selection state and coordinates with
 * AircraftRouteRenderer for the actual MapLibre rendering. Routes are only
 * shown for the selected aircraft and respect user display preferences.
 */
export class AircraftRoutes {
    private map: Map;
    private renderer: AircraftRouteRenderer;
    private routeData: RouteData | null = null;
    private selectedAircraft: string | null = null;

    // Display state
    private showRoutes: boolean = true;
    private showRouteLines: boolean = true;
    private showRouteLabels: boolean = true;
    private showRoutePoints: boolean = true;

    constructor(map: Map, displayOptions: DisplayOptions) {
        this.map = map;
        this.renderer = new AircraftRouteRenderer(map, displayOptions);

        this.showRoutes = displayOptions.showRoutes;
        this.showRouteLines = displayOptions.showRouteLines;
        this.showRouteLabels = displayOptions.showRouteLabels;
        this.showRoutePoints = displayOptions.showRoutePoints;
    }

    /**
     * Set up route layers on the map.
     * Should be called after map style loads or changes.
     */
    public setupLayers(): void {
        if (!this.map) return;

        this.renderer.setupLayers();
        this.renderer.updateRouteLinesVisibility(this.showRoutes, this.showRouteLines);
        this.renderer.updateRouteLabelsVisibility(this.showRoutes, this.showRouteLabels);
        this.renderer.updateRoutePointsVisibility(this.showRoutes, this.showRoutePoints);

        logger.debug('AircraftRoutes', 'Aircraft route layers set up');
    }

    /**
     * Update route data and display
     * @param data - Route data from server
     */
    public updateRouteData(data: RouteData): void {
        logger.debug('AircraftRoutes', 'Route data received for aircraft:', data.acid);
        this.routeData = data;
        this.updateRouteDisplay();
    }

    /**
     * Set the selected aircraft ID
     * @param aircraftId - Aircraft ID (null to deselect)
     */
    public setSelectedAircraft(aircraftId: string | null): void {
        this.selectedAircraft = aircraftId;
        this.updateRouteDisplay();
    }

    /**
     * Update route display on the map. Clears the display unless routes are
     * enabled and valid route data exists for the selected aircraft.
     */
    public updateRouteDisplay(): void {
        if (!this.routeData || !this.routeData.acid || !this.showRoutes) {
            this.clearRouteDisplay();
            return;
        }

        const data = this.routeData;

        if (data.acid !== this.selectedAircraft) {
            this.clearRouteDisplay();
            return;
        }

        if (!data.wplat || !data.wplon || !data.wpname ||
            data.wplat.length === 0 || data.wplat.length !== data.wplon.length) {
            logger.debug('AircraftRoutes', 'Invalid route data for', data.acid);
            this.clearRouteDisplay();
            return;
        }

        const activeWaypointIndex = clampActiveWaypoint(data.iactwp, data.wplat.length);
        const features = this.renderer.buildRouteFeatures(data, activeWaypointIndex);
        this.renderer.updateMapSources(features, this.showRouteLabels);
    }

    /**
     * Clear route display from map
     */
    public clearRouteDisplay(): void {
        this.renderer.clearRouteDisplay();
    }

    /**
     * Update display options (called when user changes settings)
     */
    public updateDisplayOptions(options: DisplayOptions): void {
        this.showRoutes = options.showRoutes;
        this.showRouteLines = options.showRouteLines;
        this.showRouteLabels = options.showRouteLabels;
        this.showRoutePoints = options.showRoutePoints;

        this.renderer.updateRouteLinesVisibility(this.showRoutes, this.showRouteLines);
        this.renderer.updateRouteLabelsVisibility(this.showRoutes, this.showRouteLabels);
        this.renderer.updateRoutePointsVisibility(this.showRoutes, this.showRoutePoints);
        this.renderer.updateRouteColors(options);
        this.renderer.updateLabelSize(options.mapLabelsTextSize);

        // Re-render (clears when routes were toggled off)
        this.updateRouteDisplay();
    }

    /**
     * Clear route data when aircraft is removed
     */
    public clearRouteData(): void {
        this.routeData = null;
        this.clearRouteDisplay();
    }

    /**
     * Get the current route data (used by RouteDrawingManager to anchor a
     * leader line from the last existing waypoint of an aircraft that
     * already has a route).
     */
    public getRouteData(): RouteData | null {
        return this.routeData;
    }
}
