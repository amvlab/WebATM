import { Map } from 'maplibre-gl';
import { RouteData, DisplayOptions } from '../../../data/types';
import { AircraftRouteRenderer } from './AircraftRouteRenderer';
import { logger } from '../../../utils/Logger';

/**
 * AircraftRoutes - Manages aircraft route visualization on the map
 *
 * This class handles the state and coordination for aircraft route display:
 * - Route data storage and management
 * - Selected aircraft tracking
 * - Display option integration (colors, units, visibility)
 * - Coordination with AircraftRouteRenderer for actual rendering
 *
 * Routes are only shown for the selected aircraft and respect user display preferences.
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

    // Display options (colors, units, etc.)
    private displayOptions: DisplayOptions;

    /**
     * Constructor
     * @param map - MapLibre GL map instance
     * @param displayOptions - Display options containing colors, units, toggles
     */
    constructor(map: Map, displayOptions: DisplayOptions) {
        this.map = map;
        this.displayOptions = displayOptions;

        // Create renderer for MapLibre-specific operations
        this.renderer = new AircraftRouteRenderer(map, displayOptions);

        // Initialize display state from display options
        this.showRoutes = displayOptions.showRoutes;
        this.showRouteLines = displayOptions.showRouteLines;
        this.showRouteLabels = displayOptions.showRouteLabels;
        this.showRoutePoints = displayOptions.showRoutePoints;
    }

    /**
     * Set up route layers on the map
     * Should be called after map style loads or changes
     */
    public setupLayers(): void {
        if (!this.map) return;

        this.renderer.setupLayers();

        // Set initial visibility
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
        logger.debug('AircraftRoutes', 'Route data received for aircraft:', data.acid, data);

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

        if (!aircraftId) {
            this.clearRouteDisplay();
        }
    }

    /**
     * Update route display on the map
     */
    public updateRouteDisplay(): void {
        logger.debug('AircraftRoutes', 'updateRouteDisplay called:', {
            hasRouteData: !!this.routeData,
            routeAcid: this.routeData?.acid,
            selectedAircraft: this.selectedAircraft,
            showRoutes: this.showRoutes,
            showRouteLines: this.showRouteLines,
            showRouteLabels: this.showRouteLabels,
            showRoutePoints: this.showRoutePoints
        });

        if (!this.routeData || !this.routeData.acid) {
            logger.debug('AircraftRoutes', 'No route data, clearing display');
            this.clearRouteDisplay();
            return;
        }

        if (!this.showRoutes) {
            logger.debug('AircraftRoutes', 'showRoutes is FALSE, clearing display');
            this.clearRouteDisplay();
            return;
        }

        const data = this.routeData;

        // Only show route if this aircraft is selected
        if (data.acid !== this.selectedAircraft) {
            logger.debug('AircraftRoutes', 'Route aircraft does not match selected aircraft:', data.acid, '!==', this.selectedAircraft);
            this.clearRouteDisplay();
            return;
        }

        // Validate route data
        if (!data.wplat || !data.wplon || !data.wpname ||
            data.wplat.length === 0 || data.wplat.length !== data.wplon.length) {
            logger.warn('AircraftRoutes', 'Invalid route data:', {
                hasWplat: !!data.wplat,
                hasWplon: !!data.wplon,
                hasWpname: !!data.wpname,
                wplatLength: data.wplat?.length,
                wplonLength: data.wplon?.length
            });
            this.clearRouteDisplay();
            return;
        }

        const activeWaypointIndex = data.iactwp || 0;

        logger.debug('AircraftRoutes', 'Building route features:', {
            waypointCount: data.wplat.length,
            activeWaypointIndex,
            showRouteLabels: this.showRouteLabels
        });

        // Build route features using renderer
        const features = this.renderer.buildRouteFeatures(data, activeWaypointIndex);

        // Update map sources using renderer
        this.renderer.updateMapSources(features, this.showRouteLabels);

        logger.debug('AircraftRoutes', 'Route display updated successfully');
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
        this.displayOptions = options;

        // Update visibility states
        const oldShowRoutes = this.showRoutes;
        this.showRoutes = options.showRoutes;
        this.showRouteLines = options.showRouteLines;
        this.showRouteLabels = options.showRouteLabels;
        this.showRoutePoints = options.showRoutePoints;

        // Update visibility
        this.renderer.updateRouteLinesVisibility(this.showRoutes, this.showRouteLines);
        this.renderer.updateRouteLabelsVisibility(this.showRoutes, this.showRouteLabels);
        this.renderer.updateRoutePointsVisibility(this.showRoutes, this.showRoutePoints);

        // Update colors
        this.renderer.updateRouteColors(options);

        // Update label size
        this.renderer.updateLabelSize(options.mapLabelsTextSize);

        // Update sub-option containers visibility
        if (oldShowRoutes !== this.showRoutes) {
            this.updateSubOptionContainers(this.showRoutes);
        }

        // If routes were toggled off, clear selection
        if (!this.showRoutes && oldShowRoutes) {
            logger.debug('AircraftRoutes', '🔄 Routes toggle OFF - clearing route display');
            this.clearRouteDisplay();
        } else if (this.showRoutes && !oldShowRoutes) {
            // Routes were toggled on, refresh display
            this.updateRouteDisplay();
        } else {
            // Just a sub-option change, refresh display
            this.updateRouteDisplay();
        }
    }

    /**
     * Update sub-option containers visibility in HTML
     */
    private updateSubOptionContainers(visible: boolean): void {
        const display = visible ? 'block' : 'none';

        const routeLinesContainer = document.getElementById('show-route-lines-container');
        if (routeLinesContainer) {
            routeLinesContainer.style.display = display;
        }

        const routeLabelsContainer = document.getElementById('show-route-labels-container');
        if (routeLabelsContainer) {
            routeLabelsContainer.style.display = display;
        }

        const routePointsContainer = document.getElementById('show-route-points-container');
        if (routePointsContainer) {
            routePointsContainer.style.display = display;
        }
    }

    /**
     * Clear route data when aircraft is removed
     */
    public clearRouteData(): void {
        this.routeData = null;
        this.clearRouteDisplay();
    }
}
