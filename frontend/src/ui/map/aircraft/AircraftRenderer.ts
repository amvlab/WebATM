import { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import { DataProcessor } from '../../../data/DataProcessor';
import { AircraftData, DisplayOptions } from '../../../data/types';
import { StateManager } from '../../../core/StateManager';
import { EntityRenderer, EntityShapeDrawer, EntityRenderConfig } from '../EntityRenderer';
import { featureCollection, lineStringFeature } from '../../../utils/geojson';
import { logger } from '../../../utils/Logger';
import { isValidCoordinate, buildConditionalColorExpr } from '../../../utils/maplibre';

/**
 * Aircraft shape drawing function type (for backward compatibility)
 */
export type AircraftShapeDrawer = EntityShapeDrawer;

/**
 * Trail data for a single aircraft
 */
interface AircraftTrailData {
    coordinates: [number, number][]; // [lon, lat] pairs
    lastSavedTime: number; // Simulation time when last point was saved
}

/**
 * AircraftRenderer - Handles aircraft visualization on the map
 *
 * This class extends EntityRenderer to provide aircraft-specific rendering
 * functionality, including aircraft labels with speed, altitude, and vertical
 * speed information, as well as conflict detection.
 */
export class AircraftRenderer extends EntityRenderer<AircraftData> {
    private stateManager: StateManager;

    // Trail management
    private aircraftTrails: Map<string, AircraftTrailData> = new Map();
    private readonly trailSaveInterval: number = 5; // Save trail point every 5 simulation seconds

    constructor(map: MapLibreMap, displayOptions: DisplayOptions, shapeDrawer: AircraftShapeDrawer, stateManager: StateManager) {
        // Create aircraft-specific configuration using colors from displayOptions
        const config: EntityRenderConfig = {
            entityType: 'Aircraft',
            layerPrefix: 'aircraft',
            spritePrefix: 'aircraft',
            colors: {
                normal: displayOptions.aircraftIconColor,
                selected: displayOptions.aircraftSelectedColor,
                conflict: displayOptions.aircraftConflictColor,
                label: displayOptions.aircraftLabelColor
            },
            iconSize: displayOptions.aircraftIconSize,
            shapeDrawer: shapeDrawer,
            enableTrails: true // Enable trails for aircraft
        };

        super(map, displayOptions, config);
        this.stateManager = stateManager;
    }

    /**
     * Build aircraft label text based on display options
     * Includes aircraft ID, speed, altitude, and vertical speed indicators
     */
    protected buildEntityLabel(aircraftData: AircraftData, index: number): string {
        const id = aircraftData.id[index];
        const actype = aircraftData.actype && aircraftData.actype[index] ? aircraftData.actype[index] : '';
        const altitude = aircraftData.alt ? aircraftData.alt[index] : 0;
        const verticalSpeed = aircraftData.vs ? aircraftData.vs[index] : 0;

        // Get speed based on display options (with the standard fallback chain)
        const speed = DataProcessor.getSpeedValue(aircraftData, index, this.displayOptions.speedType);

        const labelParts: string[] = [];

        if (this.displayOptions.showAircraftId) {
            labelParts.push(id);
        }

        if (this.displayOptions.showAircraftType && actype) {
            labelParts.push(actype);
        }

        if (this.displayOptions.showAircraftSpeed && speed > 0) {
            // Speed values from BlueSky are in knots
            labelParts.push(DataProcessor.formatSpeedLabel(speed, this.displayOptions.speedUnit));
        }

        if (this.displayOptions.showAircraftAltitude && altitude > 0) {
            // Altitude values from BlueSky are in meters
            let altitudeLabel = DataProcessor.formatAltitudeLabel(altitude, this.displayOptions.altitudeUnit);

            // Add vertical speed arrow
            if (Math.abs(verticalSpeed) > 0.5) {
                altitudeLabel += verticalSpeed > 0 ? '↑' : '↓';
            }

            labelParts.push(altitudeLabel);
        }

        return labelParts.join('\n');
    }

    /**
     * Get conflict status for an aircraft
     */
    protected override getConflictStatus(aircraftData: AircraftData, index: number): boolean {
        return aircraftData.inconf ? aircraftData.inconf[index] : false;
    }

    /**
     * Determine if labels should be shown
     */
    protected shouldShowLabels(): boolean {
        return this.displayOptions.showAircraftLabels;
    }

    /**
     * Determine if aircraft should be shown
     */
    protected shouldShowEntities(): boolean {
        return this.displayOptions.showAircraft;
    }

    /**
     * Determine if protected zones should be shown
     */
    protected shouldShowProtectedZones(): boolean {
        return this.displayOptions.showProtectedZones;
    }

    /**
     * ID of the 3D aircraft custom layer (kept in sync with Aircraft3DRenderer).
     * When the 3D overlay is active, we must keep this layer at the top of the
     * MapLibre layer stack so the flat 2D icons don't occlude the 3D models.
     */
    private static readonly AIRCRAFT_3D_LAYER_ID = 'aircraft-3d-layer';

    /**
     * Restore the 3D aircraft layer to the top of the MapLibre layer stack.
     * Safe to call any time — does nothing if the 3D overlay isn't enabled.
     */
    private raise3DLayerIfPresent(): void {
        if (this.map.getLayer(AircraftRenderer.AIRCRAFT_3D_LAYER_ID)) {
            this.map.moveLayer(AircraftRenderer.AIRCRAFT_3D_LAYER_ID);
        }
    }

    /**
     * Override setupLayers so that whenever the 2D aircraft sprite/label layers
     * are (re-)added, the 3D aircraft custom layer is moved back to the top.
     * Without this, a lazy 2D init (e.g. after a style change or when aircraft
     * data arrives before the map is fully ready) can leave the 2D icons
     * stacked above the 3D models.
     */
    protected override setupLayers(): void {
        super.setupLayers();
        this.raise3DLayerIfPresent();
    }

    /**
     * Update aircraft display with new data
     * Provides aircraft-specific method name for backward compatibility
     */
    public updateAircraftDisplay(aircraftData: AircraftData): void {
        // Sources may be missing if data arrives before the map finishes
        // loading, or right after a style change (which drops sources). In
        // either case, (re)initialize the renderer before updating.
        const source = this.map.getSource('aircraft-points') as GeoJSONSource;
        if (!source) {
            logger.debug('AircraftRenderer', 'Points source not found, initializing renderer...');
            this.initialize(true);

            const sourceAfterInit = this.map.getSource('aircraft-points') as GeoJSONSource;
            if (!sourceAfterInit) {
                logger.warn('AircraftRenderer', 'Failed to initialize aircraft sources');
                return;
            }
        }

        this.updateEntityDisplay(aircraftData);
        this.updateAircraftTrails(aircraftData);

        // Some code paths (style reloads, first-frame lazy init) can leave the
        // 2D sprites stacked above the 3D layer; raising here is cheap and keeps
        // the 3D models on top regardless of ordering.
        this.raise3DLayerIfPresent();
    }

    /**
     * Update aircraft trails based on current positions and simulation time
     */
    private updateAircraftTrails(aircraftData: AircraftData): void {
        // If no aircraft data, clear all trails
        if (!aircraftData.id || aircraftData.id.length === 0) {
            this.clearTrails();
            return;
        }

        const currentSimTime = this.stateManager.getSimulationTime();
        const ids = aircraftData.id;
        const lats = aircraftData.lat;
        const lons = aircraftData.lon;

        // Update trails for each aircraft
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const lat = lats[i];
            const lon = lons[i];

            // Validate coordinates
            if (!isValidCoordinate(lat, lon)) {
                continue;
            }

            // Get or create trail data for this aircraft
            let trailData = this.aircraftTrails.get(id);
            if (!trailData) {
                trailData = {
                    coordinates: [],
                    lastSavedTime: currentSimTime
                };
                this.aircraftTrails.set(id, trailData);
            }

            // Check if enough simulation time has passed to save a new point
            const timeSinceLastSave = currentSimTime - trailData.lastSavedTime;
            if (timeSinceLastSave >= this.trailSaveInterval) {
                const newPoint: [number, number] = [lon, lat];

                // Only add point if it's different from the last one (avoid duplicates)
                const lastPoint = trailData.coordinates[trailData.coordinates.length - 1];
                if (!lastPoint || lastPoint[0] !== lon || lastPoint[1] !== lat) {
                    trailData.coordinates.push(newPoint);
                    trailData.lastSavedTime = currentSimTime;
                }
            }
        }

        // Remove trails for aircraft that no longer exist
        const currentIds = new Set(ids);
        for (const trailId of this.aircraftTrails.keys()) {
            if (!currentIds.has(trailId)) {
                this.aircraftTrails.delete(trailId);
            }
        }

        // Update the trail layer
        this.updateTrailLayer(aircraftData);
    }

    /**
     * Update the trail layer with current trail data
     */
    private updateTrailLayer(aircraftData: AircraftData): void {
        const trailSource = this.map.getSource('aircraft-trails') as GeoJSONSource;
        if (!trailSource) {
            return;
        }

        const trailFeatures: GeoJSON.Feature<GeoJSON.LineString>[] = [];
        const currentIds = new Set(aircraftData.id);

        for (const [id, trailData] of this.aircraftTrails.entries()) {
            // Only render trail if aircraft still exists
            if (!currentIds.has(id)) {
                continue;
            }

            // Only create trail if we have at least 2 points
            if (trailData.coordinates.length < 2) {
                continue;
            }

            // Get aircraft index for conflict status
            const index = aircraftData.id.indexOf(id);
            const inConflict = index >= 0 ? this.getConflictStatus(aircraftData, index) : false;
            const isSelected = id === this.selectedEntity;

            trailFeatures.push(lineStringFeature(trailData.coordinates, {
                aircraftId: id,
                selected: isSelected,
                in_conflict: inConflict
            }));
        }

        // Update the trail source
        trailSource.setData(featureCollection(trailFeatures));
    }

    /**
     * Clear all aircraft trails
     */
    public clearTrails(): void {
        this.aircraftTrails.clear();

        // Clear the trail layer
        const trailSource = this.map.getSource('aircraft-trails') as GeoJSONSource;
        if (trailSource) {
            trailSource.setData(featureCollection());
        }
    }

    /**
     * Set selected aircraft
     * Provides aircraft-specific method name for backward compatibility
     */
    public setSelectedAircraft(aircraftId: string | null): void {
        this.setSelectedEntity(aircraftId);
    }

    /**
     * Update display options
     */
    public updateDisplayOptions(options: Partial<DisplayOptions>): void {
        this.displayOptions = { ...this.displayOptions, ...options };

        // Check if any colors have changed
        const colorChanged =
            options.aircraftIconColor !== undefined ||
            options.aircraftLabelColor !== undefined ||
            options.aircraftSelectedColor !== undefined ||
            options.aircraftConflictColor !== undefined ||
            options.protectedZonesColor !== undefined ||
            options.aircraftTrailColor !== undefined ||
            options.trailConflictColor !== undefined;

        // Update colors if any changed
        if (colorChanged) {
            this.updateColors({
                normal: this.displayOptions.aircraftIconColor,
                selected: this.displayOptions.aircraftSelectedColor,
                conflict: this.displayOptions.aircraftConflictColor,
                label: this.displayOptions.aircraftLabelColor
            });
            // Update trail colors
            this.updateTrailColors();
        }

        // Update aircraft icon size if changed
        if (options.aircraftIconSize !== undefined) {
            this.updateIconSize(options.aircraftIconSize);
        }

        // Update label text size if changed
        if (options.mapLabelsTextSize !== undefined && this.map.getLayer('aircraft-labels')) {
            this.map.setLayoutProperty('aircraft-labels', 'text-size', this.displayOptions.mapLabelsTextSize);
        }

        // Refresh display with new options (if colors didn't already refresh it)
        if (!colorChanged && this.entityData) {
            this.updateAircraftDisplay(this.entityData);
        }

        // Update layer visibility
        this.updateLayerVisibility();
    }

    /**
     * Update trail layer colors
     */
    private updateTrailColors(): void {
        if (!this.map.getLayer('aircraft-trails')) {
            return;
        }

        this.map.setPaintProperty(
            'aircraft-trails',
            'line-color',
            buildConditionalColorExpr(
                this.displayOptions.aircraftTrailColor,
                this.displayOptions.aircraftSelectedColor,
                this.displayOptions.trailConflictColor
            )
        );
    }

    /**
     * Change the aircraft shape at runtime
     * @param shapeDrawer - New shape drawing function
     */
    public setAircraftShape(shapeDrawer: AircraftShapeDrawer): void {
        this.setEntityShape(shapeDrawer);
    }
}
