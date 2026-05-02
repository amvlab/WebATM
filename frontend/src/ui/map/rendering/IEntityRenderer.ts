import type { Map as MapLibreMap } from 'maplibre-gl';
import type { DisplayOptions, EntityData } from '../../../data/types';

/**
 * Common interface for entity renderers (2D and 3D)
 *
 * This interface provides a unified API for rendering entities on the map,
 * allowing for different rendering implementations (e.g., 2D sprites, 3D models)
 * to be used interchangeably.
 */
export interface IEntityRenderer<T extends EntityData> {
    /**
     * Initialize renderer and add to map
     * @param map - The MapLibre GL map instance
     */
    initialize(map: MapLibreMap): void;

    /**
     * Update entities with new data
     * @param entities - Map of entity ID to entity data
     * @param simTime - Current simulation time in seconds
     */
    updateEntities(entities: Map<string, T>, simTime: number): void;

    /**
     * Update display options (colors, sizes, visibility)
     * @param options - Updated display options
     */
    updateDisplayOptions(options: DisplayOptions): void;

    /**
     * Handle map style changes
     * Called when the map style is changed to allow renderer to recreate layers
     */
    onStyleChange(): void;

    /**
     * Cleanup resources
     * Called when renderer is being destroyed or replaced
     */
    destroy(): void;

    /**
     * Get renderer type
     * @returns '2d' for sprite-based rendering, '3d' for model-based rendering
     */
    getType(): '2d' | '3d';
}
