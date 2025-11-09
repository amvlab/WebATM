import { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { EntityData, DisplayOptions } from '../../data/types';
import circle from '@turf/circle';
import { logger } from '../../utils/Logger';

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
        logger.debug(`${this.config.entityType}Renderer`, 'Initializing...');
        logger.debug(`${this.config.entityType}Renderer`, 'Map style loaded?', this.map.isStyleLoaded());
        logger.debug(`${this.config.entityType}Renderer`, 'Force immediate?', forceImmediate);

        // Wait for map style to be fully loaded before adding sprites and layers
        if (this.map.isStyleLoaded() || forceImmediate) {
            logger.debug(`${this.config.entityType}Renderer`, 'Setting up entities immediately');
            this.setupEntities();
        } else {
            logger.debug(`${this.config.entityType}Renderer`, 'Waiting for map style to load...');
            this.map.once('style.load', () => {
                logger.debug(`${this.config.entityType}Renderer`, 'Map style loaded, setting up entities');
                this.setupEntities();
            });
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
     * Create sprites for entity icons
     * Creates sprites for different states: normal, selected, and optionally conflict
     *
     * The sprite size is dynamically calculated based on the icon size multiplier
     * to avoid pixelation when scaled up. We render at 4x the needed resolution
     * and let MapLibre scale down if needed, which looks much better than scaling up.
     */
    protected createSprites(): void {
        // Calculate optimal sprite size based on current icon size multiplier
        const baseSize = 12;
        const maxScale = this.config.iconSize;
        const size = Math.ceil(baseSize * maxScale * 4); // 4x multiplier for crisp rendering at all scales

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

            // Convert canvas to ImageData and add to map
            const imageData = ctx.getImageData(0, 0, size, size);

            const options = {
                pixelRatio: window.devicePixelRatio || 1,
                sdf: false // We use high-res sprites instead of SDF for better quality
            };

            // If the image already exists, remove it first
            if (this.map.hasImage(spriteName)) {
                this.map.removeImage(spriteName);
            }

            // Add the new image
            this.map.addImage(spriteName, imageData, options);
        }

        logger.debug(`${this.config.entityType}Renderer`, `Sprites created at ${size}x${size}px for scale ${maxScale.toFixed(1)}x`);
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
            if (!this.map.getSource(trailsSourceId)) {
                this.map.addSource(trailsSourceId, {
                    type: 'geojson',
                    data: {
                        type: 'FeatureCollection',
                        features: []
                    }
                });
            }

            if (!this.map.getLayer(trailsLayerId)) {
                // Build color expression for trails
                const lineColorExpr: any[] = [
                    'case',
                    ['==', ['get', 'selected'], true],
                    this.config.colors.selected
                ];

                if (this.config.colors.conflict) {
                    lineColorExpr.push(
                        ['==', ['get', 'in_conflict'], true],
                        this.displayOptions.trailConflictColor
                    );
                }

                lineColorExpr.push(this.displayOptions.aircraftTrailColor);

                this.map.addLayer({
                    id: trailsLayerId,
                    source: trailsSourceId,
                    type: 'line',
                    layout: {
                        'line-join': 'round',
                        'line-cap': 'round',
                        'visibility': this.displayOptions.showAircraftTrails ? 'visible' : 'none'
                    },
                    paint: {
                        'line-color': lineColorExpr as any,
                        'line-width': 2,
                        'line-opacity': 0.8
                    }
                });
            }
        }

        // Add entity points source if it doesn't exist
        if (!this.map.getSource(pointsSourceId)) {
            this.map.addSource(pointsSourceId, {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: []
                }
            });
        }

        // Add protected zones source if it doesn't exist
        if (!this.map.getSource(protectedZonesSourceId)) {
            this.map.addSource(protectedZonesSourceId, {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: []
                }
            });
        }

        // Add protected zones fill layer (render first, so it appears below aircraft)
        if (!this.map.getLayer(protectedZonesLayerId)) {
            // Use protectedZonesColor from display options for protected zones
            // Override with selected/conflict colors when applicable
            const fillColorExpr: any[] = ['case', ['==', ['get', 'selected'], true], this.config.colors.selected];
            if (this.config.colors.conflict) {
                fillColorExpr.push(['==', ['get', 'in_conflict'], true], this.config.colors.conflict);
            }
            fillColorExpr.push(this.displayOptions.protectedZonesColor);

            this.map.addLayer({
                id: protectedZonesLayerId,
                source: protectedZonesSourceId,
                type: 'fill',
                paint: {
                    'fill-color': fillColorExpr as any,
                    'fill-opacity': 0.15
                },
                layout: {
                    'visibility': this.shouldShowProtectedZones() ? 'visible' : 'none'
                }
            });
        }

        // Add protected zones line layer (outline)
        const protectedZonesLineLayerId = `${this.config.layerPrefix}-protected-zones-line`;
        if (!this.map.getLayer(protectedZonesLineLayerId)) {
            // Use protectedZonesColor from display options for protected zones
            // Override with selected/conflict colors when applicable
            const lineColorExpr: any[] = ['case', ['==', ['get', 'selected'], true], this.config.colors.selected];
            if (this.config.colors.conflict) {
                lineColorExpr.push(['==', ['get', 'in_conflict'], true], this.config.colors.conflict);
            }
            lineColorExpr.push(this.displayOptions.protectedZonesColor);

            this.map.addLayer({
                id: protectedZonesLineLayerId,
                source: protectedZonesSourceId,
                type: 'line',
                paint: {
                    'line-color': lineColorExpr as any,
                    'line-width': 1.5,
                    'line-opacity': 0.6
                },
                layout: {
                    'visibility': this.shouldShowProtectedZones() ? 'visible' : 'none'
                }
            });
        }

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
                // Build icon-image expression based on available colors
                const iconImageExpr: any[] = ['case', ['==', ['get', 'selected'], true], `${this.config.spritePrefix}-selected`];

                if (this.config.colors.conflict) {
                    iconImageExpr.push(['==', ['get', 'in_conflict'], true], `${this.config.spritePrefix}-conflict`);
                }

                iconImageExpr.push(`${this.config.spritePrefix}-normal`);

                // Use symbol layer with entity icons
                this.map.addLayer({
                    id: pointsLayerId,
                    source: pointsSourceId,
                    type: 'symbol',
                    layout: {
                        'icon-image': iconImageExpr as any,
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
                // Build circle color expression
                const circleColorExpr: any[] = ['case', ['==', ['get', 'selected'], true], this.config.colors.selected];

                if (this.config.colors.conflict) {
                    circleColorExpr.push(['==', ['get', 'in_conflict'], true], this.config.colors.conflict);
                }

                circleColorExpr.push(this.config.colors.normal);

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
                        'circle-color': circleColorExpr as any,
                        'circle-stroke-color': '#ffffff',
                        'circle-stroke-width': 2,
                        'circle-opacity': 1.0
                    }
                });
            }
        }

        // Add entity labels layer - AFTER points so labels appear on top of everything
        if (!this.map.getLayer(labelsLayerId)) {
            // Build text color expression
            const textColorExpr: any[] = ['case', ['==', ['get', 'selected'], true], this.config.colors.selected];

            if (this.config.colors.conflict) {
                textColorExpr.push(['==', ['get', 'in_conflict'], true], this.config.colors.conflict);
            }

            textColorExpr.push(this.config.colors.label);

            this.map.addLayer({
                id: labelsLayerId,
                source: pointsSourceId,
                type: 'symbol',
                layout: {
                    'text-field': ['get', 'label_text'],
                    'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
                    'text-offset': [0, 1.5],
                    'text-anchor': 'top',
                    'text-size': this.displayOptions.mapLabelsTextSize,
                    'text-allow-overlap': true,
                    'text-ignore-placement': true,
                    'visibility': this.shouldShowLabels() ? 'visible' : 'none'
                },
                paint: {
                    'text-color': textColorExpr as any,
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
            source.setData({
                type: 'FeatureCollection',
                features: []
            });

            // Also clear protected zones
            const protectedZonesSource = this.map.getSource(`${this.config.layerPrefix}-protected-zones`) as GeoJSONSource;
            if (protectedZonesSource) {
                protectedZonesSource.setData({
                    type: 'FeatureCollection',
                    features: []
                });
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
            if (
                typeof lat !== 'number' || typeof lon !== 'number' ||
                isNaN(lat) || isNaN(lon) ||
                lat < -90 || lat > 90 || lon < -180 || lon > 180
            ) {
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
                const newFeature: GeoJSON.Feature<GeoJSON.Point> = {
                    type: 'Feature',
                    id: id,
                    geometry: {
                        type: 'Point',
                        coordinates: [lon, lat]
                    },
                    properties: {
                        entity_id: id,
                        label_text: labelText,
                        altitude: altitude,
                        heading: heading,
                        vertical_speed: verticalSpeed,
                        selected: id === this.selectedEntity,
                        in_conflict: inConflict
                    }
                };
                this.featureCache.set(id, newFeature);
                createdCount++;
            }
        }

        logger.debug(`${this.config.entityType}Renderer`, `Feature updates - created: ${createdCount}, updated: ${updatedCount}, skipped: ${skippedCount}`);

        // Update the entity source with cached features (single setData call)
        const featureCollection = {
            type: 'FeatureCollection' as const,
            features: Array.from(this.featureCache.values())
        };

        source.setData(featureCollection);

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
            if (
                typeof lat !== 'number' || typeof lon !== 'number' ||
                isNaN(lat) || isNaN(lon) ||
                lat < -90 || lat > 90 || lon < -180 || lon > 180
            ) {
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
        protectedZonesSource.setData({
            type: 'FeatureCollection',
            features: protectedZoneFeatures
        });
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
    protected getConflictStatus(entityData: T, index: number): boolean {
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

        // Update entity points layer
        if (this.map.getLayer(pointsLayerId)) {
            const visibility = this.shouldShowEntities() ? 'visible' : 'none';
            this.map.setLayoutProperty(pointsLayerId, 'visibility', visibility);
        }

        // Update entity labels layer
        if (this.map.getLayer(labelsLayerId)) {
            const visibility = (this.shouldShowEntities() && this.shouldShowLabels())
                ? 'visible' : 'none';
            this.map.setLayoutProperty(labelsLayerId, 'visibility', visibility);
        }

        // Update trails layer (if enabled)
        if (this.config.enableTrails && this.map.getLayer(trailsLayerId)) {
            const visibility = (this.shouldShowEntities() && this.displayOptions.showAircraftTrails)
                ? 'visible' : 'none';
            this.map.setLayoutProperty(trailsLayerId, 'visibility', visibility);
        }

        // Update protected zones fill layer
        if (this.map.getLayer(protectedZonesLayerId)) {
            const visibility = (this.shouldShowEntities() && this.shouldShowProtectedZones())
                ? 'visible' : 'none';
            this.map.setLayoutProperty(protectedZonesLayerId, 'visibility', visibility);
        }

        // Update protected zones line layer
        if (this.map.getLayer(protectedZonesLineLayerId)) {
            const visibility = (this.shouldShowEntities() && this.shouldShowProtectedZones())
                ? 'visible' : 'none';
            this.map.setLayoutProperty(protectedZonesLineLayerId, 'visibility', visibility);
        }
    }

    /**
     * Set selected entity
     * Updates the selected state and refreshes the display
     */
    public setSelectedEntity(entityId: string | null): void {
        const previousSelection = this.selectedEntity;
        this.selectedEntity = entityId;

        // Update the selected property in cached features
        if (previousSelection && this.featureCache.has(previousSelection)) {
            this.featureCache.get(previousSelection)!.properties!.selected = false;
        }
        if (entityId && this.featureCache.has(entityId)) {
            this.featureCache.get(entityId)!.properties!.selected = true;
        }

        // Refresh the display with updated selection
        if (this.entityData) {
            this.updateEntityDisplay(this.entityData);
        }
    }

    /**
     * Update icon size
     * @param iconSize - New icon size multiplier
     */
    public updateIconSize(iconSize: number): void {
        const oldIconSize = this.config.iconSize;
        this.config.iconSize = iconSize;

        // Recreate sprites if the size change is significant
        const needsSpriteRegeneration = this.shouldRegenerateSprites(oldIconSize, iconSize);

        if (needsSpriteRegeneration && this.map.getLayer(`${this.config.layerPrefix}-points`)) {
            logger.debug(`${this.config.entityType}Renderer`, `Size changed significantly (${oldIconSize.toFixed(1)} → ${iconSize.toFixed(1)}), regenerating sprites...`);
            this.createSprites();
        }

        // Update the icon size in the layer
        if (this.map.getLayer(`${this.config.layerPrefix}-points`)) {
            this.map.setLayoutProperty(`${this.config.layerPrefix}-points`, 'icon-size', iconSize);
        }

        // Refresh display with new options
        if (this.entityData) {
            this.updateEntityDisplay(this.entityData);
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
            // Build text color expression
            const textColorExpr: any[] = ['case', ['==', ['get', 'selected'], true], this.config.colors.selected];

            if (this.config.colors.conflict) {
                textColorExpr.push(['==', ['get', 'in_conflict'], true], this.config.colors.conflict);
            }

            textColorExpr.push(this.config.colors.label);

            this.map.setPaintProperty(`${this.config.layerPrefix}-labels`, 'text-color', textColorExpr as any);
        }

        // Update protected zones fill colors in the layer
        if (this.map.getLayer(`${this.config.layerPrefix}-protected-zones`)) {
            // Use protectedZonesColor from display options for protected zones
            // Override with selected/conflict colors when applicable
            const fillColorExpr: any[] = ['case', ['==', ['get', 'selected'], true], this.config.colors.selected];
            if (this.config.colors.conflict) {
                fillColorExpr.push(['==', ['get', 'in_conflict'], true], this.config.colors.conflict);
            }
            fillColorExpr.push(this.displayOptions.protectedZonesColor);

            this.map.setPaintProperty(`${this.config.layerPrefix}-protected-zones`, 'fill-color', fillColorExpr as any);
        }

        // Update protected zones line colors in the layer
        if (this.map.getLayer(`${this.config.layerPrefix}-protected-zones-line`)) {
            // Use protectedZonesColor from display options for protected zones
            // Override with selected/conflict colors when applicable
            const lineColorExpr: any[] = ['case', ['==', ['get', 'selected'], true], this.config.colors.selected];
            if (this.config.colors.conflict) {
                lineColorExpr.push(['==', ['get', 'in_conflict'], true], this.config.colors.conflict);
            }
            lineColorExpr.push(this.displayOptions.protectedZonesColor);

            this.map.setPaintProperty(`${this.config.layerPrefix}-protected-zones-line`, 'line-color', lineColorExpr as any);
        }

        // Refresh display with new colors
        if (this.entityData) {
            this.updateEntityDisplay(this.entityData);
        }
    }

    /**
     * Determine if sprites need to be regenerated based on size change
     */
    protected shouldRegenerateSprites(oldSize: number, newSize: number): boolean {
        const oldBucket = Math.floor(oldSize / 0.3);
        const newBucket = Math.floor(newSize / 0.3);
        return oldBucket !== newBucket;
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
     * Re-creates sprites and layers when the style changes
     */
    public onStyleChange(): void {
        // Wait for new style to load, then recreate sprites and layers
        this.map.once('style.load', () => {
            this.setupEntities();

            // Refresh display with current data
            if (this.entityData) {
                this.updateEntityDisplay(this.entityData);
            }
        });
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
        if (this.map.getLayer(labelsLayerId)) {
            this.map.removeLayer(labelsLayerId);
        }
        if (this.map.getLayer(pointsLayerId)) {
            this.map.removeLayer(pointsLayerId);
        }
        if (this.map.getLayer(protectedZonesLineLayerId)) {
            this.map.removeLayer(protectedZonesLineLayerId);
        }
        if (this.map.getLayer(protectedZonesLayerId)) {
            this.map.removeLayer(protectedZonesLayerId);
        }
        if (this.config.enableTrails && this.map.getLayer(trailsLayerId)) {
            this.map.removeLayer(trailsLayerId);
        }

        // Remove sources
        if (this.map.getSource(pointsSourceId)) {
            this.map.removeSource(pointsSourceId);
        }
        if (this.map.getSource(protectedZonesSourceId)) {
            this.map.removeSource(protectedZonesSourceId);
        }
        if (this.config.enableTrails && this.map.getSource(trailsSourceId)) {
            this.map.removeSource(trailsSourceId);
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
