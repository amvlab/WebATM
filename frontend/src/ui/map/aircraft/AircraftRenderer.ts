import { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import { DataProcessor } from '../../../data/DataProcessor';
import { AircraftData, AircraftTrailHistory, DisplayOptions } from '../../../data/types';
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
    /**
     * Per-aircraft point cap. A trail that outgrows it drops every other
     * point, keeping the whole flight at half the resolution (the proxy's
     * TrailManager bounds its history the same way).
     */
    private static readonly MAX_TRAIL_POINTS = 500;
    /** Set when trail points changed while the trail layer was hidden. */
    private trailLayerStale = false;

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
            // Speed values from BlueSky are in m/s
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
     * When the 3D overlay is active, this layer must stay at the top of the
     * MapLibre layer stack so the flat 2D icons don't occlude the 3D models.
     */
    private static readonly AIRCRAFT_3D_LAYER_ID = 'aircraft-3d-layer';

    /** Move the 3D aircraft layer back to the top; no-op when 3D is off. */
    private raise3DLayerIfPresent(): void {
        if (this.map.getLayer(AircraftRenderer.AIRCRAFT_3D_LAYER_ID)) {
            this.map.moveLayer(AircraftRenderer.AIRCRAFT_3D_LAYER_ID);
        }
    }

    protected override setupLayers(): void {
        super.setupLayers();
        // A lazy 2D (re-)init — style change, or data arriving before the map
        // is ready — would otherwise leave the 2D icons above the 3D models.
        this.raise3DLayerIfPresent();
    }

    /**
     * Redraw everything, trails included, so the trail features'
     * selected/conflict state stays in sync with the icons on selection,
     * shape, and style changes instead of lagging until the next frame.
     */
    public override updateEntityDisplay(aircraftData: AircraftData): void {
        super.updateEntityDisplay(aircraftData);
        this.updateTrailLayer(aircraftData);
    }

    /**
     * Update aircraft display with new data
     */
    public updateAircraftDisplay(aircraftData: AircraftData): void {
        // Sources go missing when data arrives before the map finishes loading
        // or right after a style change; (re)initialize before updating.
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

        this.updateAircraftTrails(aircraftData);
        this.updateEntityDisplay(aircraftData);

        // Style reloads and lazy init can leave the 2D sprites above the 3D layer
        this.raise3DLayerIfPresent();
    }

    /**
     * Maintain per-aircraft trail points from the incoming frame.
     *
     * Sampling uses the frame's own `simt` (the sim time BlueSky paired with
     * these positions); the ~1 Hz SIMINFO clock is only a fallback, since
     * sampling against it drifts the interval and thins trails under FF.
     */
    private updateAircraftTrails(aircraftData: AircraftData): void {
        if (!aircraftData.id || aircraftData.id.length === 0) {
            this.clearTrails();
            return;
        }

        const currentSimTime = aircraftData.simt ?? this.stateManager.getSimulationTime();
        const ids = aircraftData.id;
        const lats = aircraftData.lat;
        const lons = aircraftData.lon;

        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const lat = lats[i];
            const lon = lons[i];

            if (!isValidCoordinate(lat, lon)) {
                continue;
            }

            const trailData = this.aircraftTrails.get(id);
            if (!trailData) {
                // Seed with the current position so the trail starts where the
                // aircraft first appeared instead of one interval later.
                this.aircraftTrails.set(id, {
                    coordinates: [[lon, lat]],
                    lastSavedTime: currentSimTime
                });
                continue;
            }

            if (currentSimTime < trailData.lastSavedTime) {
                // Sim time went backwards: a RESET (or IC rerunning a scenario)
                // respawned this callsign. The stored points belong to the
                // previous run, so restart the trail at the new position —
                // otherwise the old trail stays attached as a ghost and no new
                // point records until the clock passes the old run's time.
                trailData.coordinates = [[lon, lat]];
                trailData.lastSavedTime = currentSimTime;
                continue;
            }

            if (currentSimTime - trailData.lastSavedTime >= this.trailSaveInterval) {
                // Skip duplicate points (aircraft not moving)
                const lastPoint = trailData.coordinates[trailData.coordinates.length - 1];
                if (!lastPoint || lastPoint[0] !== lon || lastPoint[1] !== lat) {
                    trailData.coordinates.push([lon, lat]);
                    trailData.lastSavedTime = currentSimTime;
                    if (trailData.coordinates.length > AircraftRenderer.MAX_TRAIL_POINTS) {
                        trailData.coordinates = AircraftRenderer.thinTrail(trailData.coordinates);
                    }
                }
            }
        }

        // Drop trails of aircraft that no longer exist
        const currentIds = new Set(ids);
        for (const trailId of this.aircraftTrails.keys()) {
            if (!currentIds.has(trailId)) {
                this.aircraftTrails.delete(trailId);
            }
        }
    }

    /** Halve a trail's resolution, keeping its first and last points. */
    private static thinTrail(coordinates: [number, number][]): [number, number][] {
        const last = coordinates[coordinates.length - 1];
        const thinned = coordinates.filter((_, index) => index % 2 === 0);
        if (thinned[thinned.length - 1] !== last) {
            thinned.push(last);
        }
        return thinned;
    }

    /**
     * Load the trail history the proxy recorded since each aircraft entered
     * the simulation (sent on socket connect), so a page opened mid-run shows
     * complete trails instead of ones starting at page load. A server trail
     * replaces the local one unless the local trail already holds more
     * points; sampling then continues locally from the live frames.
     */
    public seedTrails(history: AircraftTrailHistory): void {
        const seedTime = history.simt ?? this.stateManager.getSimulationTime();

        for (const [id, coordinates] of Object.entries(history.trails)) {
            const local = this.aircraftTrails.get(id);
            if (coordinates.length === 0 || (local && local.coordinates.length > coordinates.length)) {
                continue;
            }
            this.aircraftTrails.set(id, {
                coordinates: coordinates.map(([lon, lat]) => [lon, lat]),
                lastSavedTime: seedTime
            });
        }

        if (this.entityData) {
            this.updateTrailLayer(this.entityData);
        }
    }

    /** Whether the trail layer is currently displayed. */
    private trailsVisible(): boolean {
        return this.displayOptions.showAircraft && this.displayOptions.showAircraftTrails;
    }

    /**
     * Redraw the trail layer from the stored trail points. Trails keep being
     * recorded while hidden, but rebuilding every line on each data frame is
     * wasted work then — the redraw is deferred until they are shown again.
     */
    private updateTrailLayer(aircraftData: AircraftData): void {
        if (!this.trailsVisible()) {
            this.trailLayerStale = true;
            return;
        }

        const trailSource = this.map.getSource('aircraft-trails') as GeoJSONSource;
        if (!trailSource) {
            return;
        }
        this.trailLayerStale = false;

        const indexById = new Map((aircraftData.id ?? []).map((id, index) => [id, index]));
        const trailFeatures: GeoJSON.Feature<GeoJSON.LineString>[] = [];

        for (const [id, trailData] of this.aircraftTrails.entries()) {
            const index = indexById.get(id);
            // A line needs 2 points; skip trails of aircraft absent from this frame
            if (index === undefined || trailData.coordinates.length < 2) {
                continue;
            }

            trailFeatures.push(lineStringFeature(trailData.coordinates, {
                aircraftId: id,
                selected: id === this.selectedEntity,
                in_conflict: this.getConflictStatus(aircraftData, index)
            }));
        }

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

    /** Options that feed the sprite/label/zone/trail colors. */
    private static readonly COLOR_KEYS = [
        'aircraftIconColor',
        'aircraftLabelColor',
        'aircraftSelectedColor',
        'aircraftConflictColor',
        'protectedZonesColor',
        'aircraftTrailColor',
        'trailConflictColor'
    ] as const satisfies ReadonlyArray<keyof DisplayOptions>;

    /** Options baked into each feature's label text by buildEntityLabel. */
    private static readonly LABEL_CONTENT_KEYS = [
        'showAircraftId',
        'showAircraftType',
        'showAircraftSpeed',
        'showAircraftAltitude',
        'speedType',
        'speedUnit',
        'altitudeUnit'
    ] as const satisfies ReadonlyArray<keyof DisplayOptions>;

    /**
     * Apply changed display options. Callers pass the full DisplayOptions
     * object (MapOverlay always does), so each side effect is gated on an
     * actual value change against the previous options — an `!== undefined`
     * check would fire every side effect on every call.
     */
    public updateDisplayOptions(options: Partial<DisplayOptions>): void {
        const previous = this.displayOptions;
        this.displayOptions = { ...previous, ...options };
        const changed = (key: keyof DisplayOptions): boolean =>
            options[key] !== undefined && options[key] !== previous[key];

        if (AircraftRenderer.COLOR_KEYS.some(changed)) {
            this.updateColors({
                normal: this.displayOptions.aircraftIconColor,
                selected: this.displayOptions.aircraftSelectedColor,
                conflict: this.displayOptions.aircraftConflictColor,
                label: this.displayOptions.aircraftLabelColor
            });
            this.updateTrailColors();
        }

        if (changed('aircraftIconSize')) {
            this.updateIconSize(this.displayOptions.aircraftIconSize);
        }

        if (changed('mapLabelsTextSize') && this.map.getLayer('aircraft-labels')) {
            this.map.setLayoutProperty('aircraft-labels', 'text-size', this.displayOptions.mapLabelsTextSize);
        }

        // Label text lives in the feature properties, so a content change
        // must rebuild the features.
        if (AircraftRenderer.LABEL_CONTENT_KEYS.some(changed) && this.entityData) {
            this.updateAircraftDisplay(this.entityData);
        }

        // Trails recorded while hidden are drawn as soon as they are shown.
        if (this.trailLayerStale && this.trailsVisible() && this.entityData) {
            this.updateTrailLayer(this.entityData);
        }

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
