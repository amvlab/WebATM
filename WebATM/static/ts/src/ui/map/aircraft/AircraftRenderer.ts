import { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import { DataProcessor } from '../../../data/DataProcessor';
import { AircraftData, DisplayOptions } from '../../../data/types';
import { StateManager } from '../../../core/StateManager';
import { EntityRenderer, EntityShapeDrawer, EntityRenderConfig } from '../EntityRenderer';
import { logger } from '../../../utils/Logger';

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

        // Get speed based on display options
        let speed = 0;
        switch (this.displayOptions.speedType) {
            case 'cas':
                speed = aircraftData.cas ? aircraftData.cas[index] : 0;
                break;
            case 'tas':
                speed = aircraftData.tas ? aircraftData.tas[index] : 0;
                break;
            case 'gs':
                speed = aircraftData.gs ? aircraftData.gs[index] :
                    (aircraftData.tas ? aircraftData.tas[index] :
                        (aircraftData.cas ? aircraftData.cas[index] : 0));
                break;
            default:
                speed = aircraftData.cas ? aircraftData.cas[index] : 0;
        }

        const labelParts: string[] = [];

        if (this.displayOptions.showAircraftId) {
            labelParts.push(id);
        }

        if (this.displayOptions.showAircraftType && actype) {
            labelParts.push(actype);
        }

        if (this.displayOptions.showAircraftSpeed && speed > 0) {
            // Speed values from BlueSky are in knots, format using DataProcessor
            const speedValue = Math.round(DataProcessor.convertSpeed(speed, this.displayOptions.speedUnit));
            const speedUnit = this.getSpeedUnitLabel(this.displayOptions.speedUnit);
            labelParts.push(`${speedValue}${speedUnit}`);
        }

        if (this.displayOptions.showAircraftAltitude && altitude > 0) {
            // Altitude values from BlueSky are in feet, format using DataProcessor
            const converted = DataProcessor.convertAltitude(altitude, this.displayOptions.altitudeUnit);
            let altitudeLabel: string;

            // Format based on unit type
            switch (this.displayOptions.altitudeUnit) {
                case 'fl':
                    altitudeLabel = 'FL' + Math.round(converted).toString().padStart(3, '0');
                    break;
                case 'km':
                    altitudeLabel = converted.toFixed(1) + 'km';
                    break;
                case 'ft':
                    altitudeLabel = Math.round(converted).toString() + 'ft';
                    break;
                case 'm':
                    altitudeLabel = Math.round(converted).toString() + 'm';
                    break;
                default:
                    altitudeLabel = Math.round(converted).toString();
                    break;
            }

            // Add vertical speed arrow
            if (Math.abs(verticalSpeed) > 0.5) {
                altitudeLabel += verticalSpeed > 0 ? '↑' : '↓';
            }

            labelParts.push(altitudeLabel);
        }

        return labelParts.join('\n');
    }

    /**
     * Get unit label suffix for speed display
     */
    private getSpeedUnitLabel(unit: string): string {
        switch (unit) {
            case 'knots':
                return 'kt';
            case 'km/h':
                return 'km/h';
            case 'mph':
                return 'mph';
            case 'm/s':
                return 'm/s';
            default:
                return 'kt';
        }
    }

    /**
     * Get conflict status for an aircraft
     */
    protected getConflictStatus(aircraftData: AircraftData, index: number): boolean {
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
     * Update aircraft display with new data
     * Provides aircraft-specific method name for backward compatibility
     */
    public updateAircraftDisplay(aircraftData: AircraftData): void {
        // Check if map sources are ready before updating
        // This handles the race condition where aircraft data arrives before map finishes loading
        const source = this.map.getSource('aircraft-points') as GeoJSONSource;
        if (!source) {
            // Sources not ready yet, which can happen:
            // 1. During initial map load 
            // 2. After map style change (sources are removed)
            // In both cases, we need to initialize the renderer
            logger.debug('AircraftRenderer', 'Points source not found, initializing renderer...');
            this.initialize(true);
            
            // After initialization, try updating again
            const sourceAfterInit = this.map.getSource('aircraft-points') as GeoJSONSource;
            if (!sourceAfterInit) {
                logger.warn('AircraftRenderer', 'Failed to initialize aircraft sources');
                return;
            }
        }

        this.updateEntityDisplay(aircraftData);
        this.updateAircraftTrails(aircraftData);
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
            if (
                typeof lat !== 'number' || typeof lon !== 'number' ||
                isNaN(lat) || isNaN(lon) ||
                lat < -90 || lat > 90 || lon < -180 || lon > 180
            ) {
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

            trailFeatures.push({
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: trailData.coordinates
                },
                properties: {
                    aircraftId: id,
                    selected: isSelected,
                    in_conflict: inConflict
                }
            });
        }

        // Update the trail source
        trailSource.setData({
            type: 'FeatureCollection',
            features: trailFeatures
        });
    }

    /**
     * Clear all aircraft trails
     */
    public clearTrails(): void {
        this.aircraftTrails.clear();

        // Clear the trail layer
        const trailSource = this.map.getSource('aircraft-trails') as GeoJSONSource;
        if (trailSource) {
            trailSource.setData({
                type: 'FeatureCollection',
                features: []
            });
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
        const oldIconSize = this.displayOptions.aircraftIconSize;
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

        // Build color expression for trails
        const lineColorExpr: any[] = [
            'case',
            ['==', ['get', 'selected'], true],
            this.displayOptions.aircraftSelectedColor,
            ['==', ['get', 'in_conflict'], true],
            this.displayOptions.trailConflictColor,
            this.displayOptions.aircraftTrailColor
        ];

        this.map.setPaintProperty('aircraft-trails', 'line-color', lineColorExpr as any);
    }

    /**
     * Change the aircraft shape at runtime
     * @param shapeDrawer - New shape drawing function
     */
    public setAircraftShape(shapeDrawer: AircraftShapeDrawer): void {
        this.setEntityShape(shapeDrawer);
    }
}
