import { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { EntityData, DisplayOptions } from '../../data/types';
import circle from '@turf/circle';
import { featureCollection, pointFeature } from '../../utils/geojson';
import { logger } from '../../utils/Logger';
import {
    ensureGeoJSONSource,
    ensureLayer,
    buildConditionalColorExpr,
    buildConditionalImageExpr,
    setLayerVisibility,
    isValidCoordinate,
    safeRemoveLayer,
    safeRemoveSource
} from '../../utils/maplibre';

/**
 * Entity shape drawing function type
 * @param ctx - Canvas 2D rendering context
 * @param size - Canvas size (width and height)
 */
export type EntityShapeDrawer = (ctx: CanvasRenderingContext2D, size: number) => void;

/**
 * Entity colors configuration
 */
export interface EntityColors {
    normal: string;
    selected: string;
    conflict?: string;
    label: string;
}

/**
 * Entity rendering configuration
 */
export interface EntityRenderConfig {
    entityType: string;              // Entity type identifier (e.g., 'aircraft', 'bird')
    layerPrefix: string;             // Prefix for layer names (e.g., 'aircraft', 'bird')
    spritePrefix: string;            // Prefix for sprite names (e.g., 'aircraft', 'bird')
    colors: EntityColors;            // Color configuration
    iconSize: number;                // Icon size multiplier
    shapeDrawer: EntityShapeDrawer;  // Shape drawing function
    enableTrails?: boolean;          // Enable trail rendering (optional, default false)
}

/**
 * EntityRenderer - Base class for rendering entities on the map
 *
 * This abstract class provides common functionality for rendering any type of
 * moving entity (aircraft, birds, drones, vehicles, etc.) on the MapLibre GL map.
 * Subclasses must implement entity-specific label building logic.
 */
/**
 * Sprite canvas resolution in pixels. Fixed and oversampled: MapLibre scales
 * the sprite down to SPRITE_CSS_SIZE, so it stays crisp on high-DPI screens
 * across the whole icon-size slider range.
 */
export const SPRITE_CANVAS_PX = 128;

/**
 * Rendered sprite size in CSS pixels at icon-size 1.0. The displayed size is
 * SPRITE_CSS_SIZE * iconSize on every screen. The value keeps the default
 * appearance (0.8 → ~31 px) of the previous renderer, which drew the sprite
 * at 12 * iconSize * 4 canvas pixels.
 */
export const SPRITE_CSS_SIZE = 38.4;

export abstract class EntityRenderer<T extends EntityData> {
    protected map: MapLibreMap;
    protected displayOptions: DisplayOptions;
    protected config: EntityRenderConfig;

    // State tracking
    protected selectedEntity: string | null = null;
    protected entityData: T | null = null;

    // Feature cache for efficient incremental updates
    protected featureCache = new Map<string, GeoJSON.Feature<GeoJSON.Point>>();

    constructor(map: MapLibreMap, displayOptions: DisplayOptions, config: EntityRenderConfig) {
        this.map = map;
        this.displayOptions = displayOptions;
        this.config = config;
    }

    /**
     * Initialize the entity renderer
     * Creates sprites and sets up map layers
     * @param forceImmediate - Force immediate setup even if style check fails (use when called from map load callback)
     */
    public initialize(forceImmediate: boolean = false): void {
        logger.debug(`${this.config.entityType}Renderer`, `Initializing (style loaded: ${this.map.isStyleLoaded()}, force: ${forceImmediate})`);

        // Wait for map style to be fully loaded before adding sprites and layers
        if (this.map.isStyleLoaded() || forceImmediate) {
            this.setupEntities();
        } else {
            this.map.once('style.load', () => this.setupEntities());
        }
    }

    /**
     * Set up entity sprites and layers
     */
    protected setupEntities(): void {
        // Create entity sprites with different colors
        this.createSprites();

        // Set up entity layers (sources and map layers)
        this.setupLayers();

        logger.info(`${this.config.entityType}Renderer`, 'Initialized - sprites and layers ready');
    }

    /**
     * Create sprites for entity states: normal, selected, and optionally
     * conflict. Drawn once at a fixed oversampled resolution; the on-screen
     * size is controlled solely by the layer's icon-size property.
     */
    protected createSprites(): void {
        const size = SPRITE_CANVAS_PX;

        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        if (!ctx) {
            logger.error(`${this.config.entityType}Renderer`, 'Failed to get canvas context for sprites');
            return;
        }

        // Define colors for different entity states
        const colorStates: Record<string, string> = {
            [`${this.config.spritePrefix}-normal`]: this.config.colors.normal,
            [`${this.config.spritePrefix}-selected`]: this.config.colors.selected
        };

        // Add conflict color if provided
        if (this.config.colors.conflict) {
            colorStates[`${this.config.spritePrefix}-conflict`] = this.config.colors.conflict;
        }

        // Create a sprite for each state
        for (const [spriteName, color] of Object.entries(colorStates)) {
            // Clear canvas
            ctx.clearRect(0, 0, size, size);

            // Set drawing styles
            ctx.fillStyle = color;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = Math.max(1, size / 24);

            // Draw the entity shape
            this.config.shapeDrawer(ctx, size);

            // Fill and stroke the shape
            ctx.fill();
            ctx.stroke();

            const imageData = ctx.getImageData(0, 0, size, size);

            const options = {
                // Scale the oversampled canvas down to SPRITE_CSS_SIZE so the
                // rendered size is DPR-independent and linear in icon-size.
                pixelRatio: size / SPRITE_CSS_SIZE,
                sdf: false
            };

            // If the image already exists, remove it first
            if (this.map.hasImage(spriteName)) {
                this.map.removeImage(spriteName);
            }

            // Add the new image
            this.map.addImage(spriteName, imageData, options);
        }

        logger.debug(`${this.config.entityType}Renderer`, `Sprites created at ${size}x${size}px`);
    }

    /**
     * Set up entity map layers
     * Creates sources and layers for entity points and labels
     */
    protected setupLayers(): void {
        const pointsSourceId = `${this.config.layerPrefix}-points`;
        const pointsLayerId = `${this.config.layerPrefix}-points`;
        const labelsLayerId = `${this.config.layerPrefix}-labels`;
        const protectedZonesSourceId = `${this.config.layerPrefix}-protected-zones`;
        const protectedZonesLayerId = `${this.config.layerPrefix}-protected-zones`;
        const trailsSourceId = `${this.config.layerPrefix}-trails`;
        const trailsLayerId = `${this.config.layerPrefix}-trails`;

        // Add trail source and layer FIRST (if trails are enabled) so they appear behind points
        if (this.config.enableTrails) {
            ensureGeoJSONSource(this.map, trailsSourceId);
            ensureLayer(this.map, {
                id: trailsLayerId,
                source: trailsSourceId,
                type: 'line',
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round',
                    'visibility': this.displayOptions.showAircraftTrails ? 'visible' : 'none'
                },
                paint: {
                    'line-color': buildConditionalColorExpr(
                        this.displayOptions.aircraftTrailColor,
                        this.config.colors.selected,
                        this.config.colors.conflict ? this.displayOptions.trailConflictColor : undefined
                    ),
                    'line-width': 2,
                    'line-opacity': 0.8
                }
            });
        }

        // Add entity points source if it doesn't exist
        ensureGeoJSONSource(this.map, pointsSourceId);

        // Add protected zones source if it doesn't exist
        ensureGeoJSONSource(this.map, protectedZonesSourceId);

        // Add protected zones fill layer (render first, so it appears below aircraft)
        ensureLayer(this.map, {
            id: protectedZonesLayerId,
            source: protectedZonesSourceId,
            type: 'fill',
            paint: {
                'fill-color': buildConditionalColorExpr(
                    this.displayOptions.protectedZonesColor,
                    this.config.colors.selected,
                    this.config.colors.conflict
                ),
                'fill-opacity': 0.15
            },
            layout: {
                'visibility': this.shouldShowProtectedZones() ? 'visible' : 'none'
            }
        });

        // Add protected zones line layer (outline)
        const protectedZonesLineLayerId = `${this.config.layerPrefix}-protected-zones-line`;
        ensureLayer(this.map, {
            id: protectedZonesLineLayerId,
            source: protectedZonesSourceId,
            type: 'line',
            paint: {
                'line-color': buildConditionalColorExpr(
                    this.displayOptions.protectedZonesColor,
                    this.config.colors.selected,
                    this.config.colors.conflict
                ),
                'line-width': 1.5,
                'line-opacity': 0.6
            },
            layout: {
                'visibility': this.shouldShowProtectedZones() ? 'visible' : 'none'
            }
        });

        // Entity points and labels layers will be added at the END in addEntityLayersOnTop()
        // to ensure they render above all other layers (routes, protected zones, etc.)
        this.addEntityLayersOnTop(pointsSourceId, pointsLayerId, labelsLayerId);

        logger.debug(`${this.config.entityType}Renderer`, 'Layers created');
    }

    /**
     * Add entity points and labels layers on top of all other layers
     * This ensures aircraft/entities render above routes, protected zones, etc.
     */
    private addEntityLayersOnTop(pointsSourceId: string, pointsLayerId: string, labelsLayerId: string): void {
        // Add entity points layer (icons) - AFTER all other layers so it appears on top
        if (!this.map.getLayer(pointsLayerId)) {
            const useSprite = this.map.hasImage(`${this.config.spritePrefix}-normal`);

            if (useSprite) {
                // Use symbol layer with entity icons
                this.map.addLayer({
                    id: pointsLayerId,
                    source: pointsSourceId,
                    type: 'symbol',
                    layout: {
                        'icon-image': buildConditionalImageExpr(
                            `${this.config.spritePrefix}-normal`,
                            `${this.config.spritePrefix}-selected`,
                            this.config.colors.conflict ? `${this.config.spritePrefix}-conflict` : undefined
                        ),
                        'icon-size': this.config.iconSize,
                        'icon-rotate': ['get', 'heading'],
                        'icon-rotation-alignment': 'map',
                        'icon-allow-overlap': true,
                        'icon-ignore-placement': true,
                        'icon-anchor': 'center'
                    },
                    paint: {
                        'icon-opacity': 1.0
                    }
                });
            } else {
                // Fallback to circle layer if sprites aren't available
                this.map.addLayer({
                    id: pointsLayerId,
                    source: pointsSourceId,
                    type: 'circle',
                    paint: {
                        'circle-radius': [
                            'case',
                            ['==', ['get', 'selected'], true],
                            12,
                            10
                        ],
                        'circle-color': buildConditionalColorExpr(
                            this.config.colors.normal,
                            this.config.colors.selected,
                            this.config.colors.conflict
                        ),
                        'circle-stroke-color': '#ffffff',
                        'circle-stroke-width': 2,
                        'circle-opacity': 1.0
                    }
                });
            }
        }

        // Add entity labels layer - AFTER points so labels appear on top of everything
        if (!this.map.getLayer(labelsLayerId)) {
            this.map.addLayer({
                id: labelsLayerId,
                source: pointsSourceId,
                type: 'symbol',
                layout: {
                    'text-field': ['get', 'label_text'],
                    'text-font': ['Open Sans Regular'],
                    'text-offset': [0, 1.5],
                    'text-anchor': 'top',
                    'text-size': this.displayOptions.mapLabelsTextSize,
                    // Icons stay always-visible (icon-*-overlap above); labels
                    // use MapLibre's collision engine, so overlapping labels are
                    // hidden by priority: selected > in-conflict > normal.
                    'text-allow-overlap': false,
                    'text-ignore-placement': false,
                    'symbol-sort-key': [
                        'case',
                        ['==', ['get', 'selected'], true], 0,
                        ['==', ['get', 'in_conflict'], true], 1,
                        2
                    ],
                    'visibility': this.shouldShowLabels() ? 'visible' : 'none'
                },
                paint: {
                    'text-color': buildConditionalColorExpr(
                        this.config.colors.label,
                        this.config.colors.selected,
                        this.config.colors.conflict
                    ),
                    'text-halo-color': '#ffffff',
                    'text-halo-width': 2
                }
            });
        }
    }

    /**
     * Get the protected zone radius for an entity
     * @param entityData - Entity data
     * @param index - Index of the entity in the data arrays
     * @returns Radius in meters, or 0 if no protected zone
     */
    protected getProtectedZoneRadius(entityData: T, index: number): number {
        // Return rpz value from EntityData if available
        return entityData.rpz ? entityData.rpz[index] : 0;
    }

    /**
     * Update entity display with new data using efficient incremental updates
     * @param entityData - Entity data to display
     */
    public updateEntityDisplay(entityData: T): void {
        this.entityData = entityData;

        const source = this.map.getSource(`${this.config.layerPrefix}-points`) as GeoJSONSource;
        if (!source) {
            logger.warn(`${this.config.entityType}Renderer`, 'Points source not found');
            return;
        }

        // Handle empty data
        if (!entityData.id || entityData.id.length === 0) {
            logger.verbose(`${this.config.entityType}Renderer`, 'Empty entity data, clearing features');
            this.featureCache.clear();
            source.setData(featureCollection());

            // Also clear protected zones
            const protectedZonesSource = this.map.getSource(`${this.config.layerPrefix}-protected-zones`) as GeoJSONSource;
            if (protectedZonesSource) {
                protectedZonesSource.setData(featureCollection());
            }
            return;
        }

        const ids = entityData.id;
        const lats = entityData.lat;
        const lons = entityData.lon;

        logger.debug(`${this.config.entityType}Renderer`, `Updating ${ids.length} entities`);

        // Track current entity IDs for removal detection
        const currentIds = new Set<string>(ids);

        // Remove entities that no longer exist
        let removedCount = 0;
        for (const cachedId of this.featureCache.keys()) {
            if (!currentIds.has(cachedId)) {
                this.featureCache.delete(cachedId);
                removedCount++;
            }
        }
        if (removedCount > 0) {
            logger.debug(`${this.config.entityType}Renderer`, `Removed ${removedCount} entities from cache`);
        }

        // Update or add entity features
        let updatedCount = 0;
        let createdCount = 0;
        let skippedCount = 0;
        for (let i = 0; i < ids.length; i++) {
            const lat = lats[i];
            const lon = lons[i];
            const id = ids[i];

            // Validate coordinates
            if (!isValidCoordinate(lat, lon)) {
                skippedCount++;
                if (skippedCount <= 3) {
                    logger.warn(`${this.config.entityType}Renderer`, `Skipping entity ${id} - invalid coordinates:`, { lat, lon });
                }
                continue;
            }

            const heading = entityData.trk ? entityData.trk[i] : 0;
            const altitude = entityData.alt ? entityData.alt[i] : 0;
            const verticalSpeed = entityData.vs ? entityData.vs[i] : 0;

            // Build label text (entity-specific implementation)
            const labelText = this.buildEntityLabel(entityData, i);

            // Get conflict status (if applicable)
            const inConflict = this.getConflictStatus(entityData, i);

            // Check if feature exists in cache
            const existingFeature = this.featureCache.get(id);

            if (existingFeature) {
                // Update existing feature in-place
                existingFeature.geometry.coordinates = [lon, lat];
                existingFeature.properties!.label_text = labelText;
                existingFeature.properties!.altitude = altitude;
                existingFeature.properties!.heading = heading;
                existingFeature.properties!.vertical_speed = verticalSpeed;
                existingFeature.properties!.selected = id === this.selectedEntity;
                existingFeature.properties!.in_conflict = inConflict;
                updatedCount++;
            } else {
                // Create new feature and add to cache
                const newFeature = pointFeature([lon, lat], {
                    entity_id: id,
                    label_text: labelText,
                    altitude: altitude,
                    heading: heading,
                    vertical_speed: verticalSpeed,
                    selected: id === this.selectedEntity,
                    in_conflict: inConflict
                }, id);
                this.featureCache.set(id, newFeature);
                createdCount++;
            }
        }

        logger.debug(`${this.config.entityType}Renderer`, `Feature updates - created: ${createdCount}, updated: ${updatedCount}, skipped: ${skippedCount}`);

        // Update the entity source with cached features (single setData call)
        source.setData(featureCollection(Array.from(this.featureCache.values())));

        // Update protected zones
        this.updateProtectedZones(entityData);

        // Update layer visibility based on display options
        this.updateLayerVisibility();
    }

    /**
     * Update protected zones display
     * Creates circle polygon features for each entity's protected zone using turf.js
     */
    protected updateProtectedZones(entityData: T): void {
        const protectedZonesSource = this.map.getSource(`${this.config.layerPrefix}-protected-zones`) as GeoJSONSource;
        if (!protectedZonesSource) {
            return;
        }

        const ids = entityData.id;
        const lats = entityData.lat;
        const lons = entityData.lon;

        const protectedZoneFeatures: GeoJSON.Feature<GeoJSON.Polygon>[] = [];

        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const lat = lats[i];
            const lon = lons[i];

            // Skip invalid coordinates
            if (!isValidCoordinate(lat, lon)) {
                continue;
            }

            // Get protected zone radius for this entity
            const radiusMeters = this.getProtectedZoneRadius(entityData, i);

            // Skip if no protected zone
            if (!radiusMeters || radiusMeters <= 0) {
                continue;
            }

            // Convert radius from meters to kilometers for turf.circle
            const radiusKm = radiusMeters / 1000;

            // Get conflict status
            const inConflict = this.getConflictStatus(entityData, i);

            // Generate a circular polygon using turf.circle
            // See https://turfjs.org/docs/#circle
            const circlePolygon = circle([lon, lat], radiusKm, {
                steps: 64,
                units: 'kilometers'
            });

            // Add properties to the feature
            circlePolygon.properties = {
                entity_id: id,
                radius_meters: radiusMeters,
                selected: id === this.selectedEntity,
                in_conflict: inConflict
            };
            circlePolygon.id = `${id}-zone`;

            protectedZoneFeatures.push(circlePolygon);
        }

        // Update the protected zones source
        protectedZonesSource.setData(featureCollection(protectedZoneFeatures));
    }

    /**
     * Build entity label text - must be implemented by subclasses
     * @param entityData - Entity data
     * @param index - Index of the entity in the data arrays
     */
    protected abstract buildEntityLabel(entityData: T, index: number): string;

    /**
     * Get conflict status for an entity - can be overridden by subclasses
     * @param entityData - Entity data
     * @param index - Index of the entity in the data arrays
     */
    protected getConflictStatus(_entityData: T, _index: number): boolean {
        // Default: no conflict detection
        // Subclasses can override to provide specific conflict detection
        return false;
    }

    /**
     * Determine if labels should be shown - can be overridden by subclasses
     */
    protected abstract shouldShowLabels(): boolean;

    /**
     * Determine if entities should be shown - can be overridden by subclasses
     */
    protected abstract shouldShowEntities(): boolean;

    /**
     * Determine if protected zones should be shown - can be overridden by subclasses
     */
    protected abstract shouldShowProtectedZones(): boolean;

    /**
     * Update layer visibility based on display options
     */
    protected updateLayerVisibility(): void {
        const pointsLayerId = `${this.config.layerPrefix}-points`;
        const labelsLayerId = `${this.config.layerPrefix}-labels`;
        const protectedZonesLayerId = `${this.config.layerPrefix}-protected-zones`;
        const protectedZonesLineLayerId = `${this.config.layerPrefix}-protected-zones-line`;
        const trailsLayerId = `${this.config.layerPrefix}-trails`;

        const showEntities = this.shouldShowEntities();
        setLayerVisibility(this.map, pointsLayerId, showEntities);
        setLayerVisibility(this.map, labelsLayerId, showEntities && this.shouldShowLabels());
        if (this.config.enableTrails) {
            setLayerVisibility(this.map, trailsLayerId, showEntities && this.displayOptions.showAircraftTrails);
        }
        const showZones = showEntities && this.shouldShowProtectedZones();
        setLayerVisibility(this.map, protectedZonesLayerId, showZones);
        setLayerVisibility(this.map, protectedZonesLineLayerId, showZones);
    }

    /**
     * Set selected entity
     * Updates the selected state and refreshes the display
     */
    public setSelectedEntity(entityId: string | null): void {
        this.selectedEntity = entityId;

        // Refresh the display; it recomputes the 'selected' property of every feature
        if (this.entityData) {
            this.updateEntityDisplay(this.entityData);
        }
    }

    /**
     * Update icon size
     * @param iconSize - New icon size multiplier
     */
    public updateIconSize(iconSize: number): void {
        this.config.iconSize = iconSize;

        // Sprites are resolution-independent, so only the layer property changes
        if (this.map.getLayer(`${this.config.layerPrefix}-points`)) {
            this.map.setLayoutProperty(`${this.config.layerPrefix}-points`, 'icon-size', iconSize);
        }
    }

    /**
     * Update entity colors
     * @param colors - New color configuration
     */
    public updateColors(colors: Partial<EntityColors>): void {
        // Update config colors
        this.config.colors = { ...this.config.colors, ...colors };

        // Recreate sprites with new colors
        if (this.map.getLayer(`${this.config.layerPrefix}-points`)) {
            logger.debug(`${this.config.entityType}Renderer`, 'Colors updated, regenerating sprites...');
            this.createSprites();
        }

        // Update label text colors in the layer
        if (this.map.getLayer(`${this.config.layerPrefix}-labels`)) {
            this.map.setPaintProperty(
                `${this.config.layerPrefix}-labels`,
                'text-color',
                buildConditionalColorExpr(
                    this.config.colors.label,
                    this.config.colors.selected,
                    this.config.colors.conflict
                )
            );
        }

        // Update protected zones fill colors in the layer
        if (this.map.getLayer(`${this.config.layerPrefix}-protected-zones`)) {
            this.map.setPaintProperty(
                `${this.config.layerPrefix}-protected-zones`,
                'fill-color',
                buildConditionalColorExpr(
                    this.displayOptions.protectedZonesColor,
                    this.config.colors.selected,
                    this.config.colors.conflict
                )
            );
        }

        // Update protected zones line colors in the layer
        if (this.map.getLayer(`${this.config.layerPrefix}-protected-zones-line`)) {
            this.map.setPaintProperty(
                `${this.config.layerPrefix}-protected-zones-line`,
                'line-color',
                buildConditionalColorExpr(
                    this.displayOptions.protectedZonesColor,
                    this.config.colors.selected,
                    this.config.colors.conflict
                )
            );
        }

        // Refresh display with new colors
        if (this.entityData) {
            this.updateEntityDisplay(this.entityData);
        }
    }

    /**
     * Change the entity shape at runtime
     * @param shapeDrawer - New shape drawing function
     */
    public setEntityShape(shapeDrawer: EntityShapeDrawer): void {
        this.config.shapeDrawer = shapeDrawer;

        // Recreate sprites with new shape
        this.createSprites();

        // Refresh display if we have data
        if (this.entityData) {
            this.updateEntityDisplay(this.entityData);
        }

        logger.debug(`${this.config.entityType}Renderer`, 'Shape updated');
    }

    /**
     * Handle map style changes
     * Re-creates sprites and layers when the style changes.
     *
     * If the style is already loaded (e.g. this was invoked from within a
     * 'style.load' handler), run setup synchronously — otherwise `once('style.load')`
     * would queue the callback until the *next* style change, which leaves the
     * aircraft layers missing and can race with other renderers re-adding
     * their own layers in the meantime.
     */
    public onStyleChange(): void {
        const runSetup = () => {
            this.setupEntities();

            // Refresh display with current data
            if (this.entityData) {
                this.updateEntityDisplay(this.entityData);
            }
        };

        if (this.map.isStyleLoaded()) {
            runSetup();
        } else {
            this.map.once('style.load', runSetup);
        }
    }

    /**
     * Clean up resources
     */
    public destroy(): void {
        const labelsLayerId = `${this.config.layerPrefix}-labels`;
        const pointsLayerId = `${this.config.layerPrefix}-points`;
        const pointsSourceId = `${this.config.layerPrefix}-points`;
        const protectedZonesLayerId = `${this.config.layerPrefix}-protected-zones`;
        const protectedZonesLineLayerId = `${this.config.layerPrefix}-protected-zones-line`;
        const protectedZonesSourceId = `${this.config.layerPrefix}-protected-zones`;
        const trailsLayerId = `${this.config.layerPrefix}-trails`;
        const trailsSourceId = `${this.config.layerPrefix}-trails`;

        // Remove layers (in reverse order of creation)
        safeRemoveLayer(this.map, labelsLayerId);
        safeRemoveLayer(this.map, pointsLayerId);
        safeRemoveLayer(this.map, protectedZonesLineLayerId);
        safeRemoveLayer(this.map, protectedZonesLayerId);
        if (this.config.enableTrails) {
            safeRemoveLayer(this.map, trailsLayerId);
        }

        // Remove sources
        safeRemoveSource(this.map, pointsSourceId);
        safeRemoveSource(this.map, protectedZonesSourceId);
        if (this.config.enableTrails) {
            safeRemoveSource(this.map, trailsSourceId);
        }

        // Remove sprites
        if (this.map.hasImage(`${this.config.spritePrefix}-normal`)) {
            this.map.removeImage(`${this.config.spritePrefix}-normal`);
        }
        if (this.map.hasImage(`${this.config.spritePrefix}-selected`)) {
            this.map.removeImage(`${this.config.spritePrefix}-selected`);
        }
        if (this.config.colors.conflict && this.map.hasImage(`${this.config.spritePrefix}-conflict`)) {
            this.map.removeImage(`${this.config.spritePrefix}-conflict`);
        }

        logger.info(`${this.config.entityType}Renderer`, 'Destroyed');
    }
}
