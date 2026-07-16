import type { IEntityRenderer } from '../rendering/IEntityRenderer';
import { Aircraft2DRenderer } from './Aircraft2DRenderer';
import type { AircraftData, DisplayOptions } from '../../../data/types';
import type { StateManager } from '../../../core/StateManager';
import type { AircraftRoute3DRenderer } from './AircraftRoute3DRenderer';
import { logger } from '../../../utils/Logger';

/**
 * Factory for creating aircraft renderers.
 *
 * The 2D renderer is always active; the 3D renderer is an optional overlay
 * that runs alongside it. Three.js is lazy-loaded on first 3D use.
 */
export class AircraftRendererFactory {
    /** Create the always-active 2D renderer. */
    static create2D(
        displayOptions: DisplayOptions,
        stateManager: StateManager
    ): IEntityRenderer<AircraftData> {
        return new Aircraft2DRenderer(displayOptions, stateManager);
    }

    /**
     * Lazy-load and instantiate the 3D overlay renderer.
     *
     * Returns null when the Three.js chunk fails to load so the caller leaves
     * the overlay off — falling back to a 2D renderer here would duplicate the
     * always-active 2D renderer's fixed map layer/source IDs.
     */
    static async create3D(
        displayOptions: DisplayOptions,
        stateManager: StateManager
    ): Promise<IEntityRenderer<AircraftData> | null> {
        try {
            const module = await import(/* webpackChunkName: "aircraft-3d" */ './Aircraft3DRenderer');
            return new module.Aircraft3DRenderer(displayOptions, stateManager);
        } catch (error) {
            logger.warn('AircraftRendererFactory', 'Failed to load 3D renderer:', error);
            return null;
        }
    }

    /**
     * Lazy-load and instantiate the 3D aircraft route renderer.
     * Reuses the "aircraft-3d" webpack chunk so Three.js is loaded once.
     */
    static async createRoute3D(displayOptions: DisplayOptions): Promise<AircraftRoute3DRenderer | null> {
        try {
            const module = await import(
                /* webpackChunkName: "aircraft-3d" */ './AircraftRoute3DRenderer'
            );
            return new module.AircraftRoute3DRenderer(displayOptions);
        } catch (error) {
            logger.warn('AircraftRendererFactory', 'Failed to load 3D route renderer:', error);
            return null;
        }
    }
}
