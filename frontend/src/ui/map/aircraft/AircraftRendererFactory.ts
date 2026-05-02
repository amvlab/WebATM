import type { IEntityRenderer } from '../rendering/IEntityRenderer';
import { Aircraft2DRenderer } from './Aircraft2DRenderer';
import type { AircraftData, DisplayOptions } from '../../../data/types';
import type { StateManager } from '../../../core/StateManager';
import { AIRCRAFT_SHAPES } from './AircraftShapes';
import type { AircraftShapeDrawer } from './AircraftRenderer';
import type { AircraftRoute3DRenderer } from './AircraftRoute3DRenderer';
import { logger } from '../../../utils/Logger';

/**
 * Factory for creating aircraft renderers.
 *
 * 2D renderer is always active; 3D renderer is an optional overlay that
 * runs alongside 2D when enabled. Three.js is lazy-loaded on first use.
 */
export class AircraftRendererFactory {
    static async create(
        displayOptions: DisplayOptions,
        stateManager: StateManager,
        requested3D?: boolean
    ): Promise<IEntityRenderer<AircraftData>> {
        const want3D = requested3D ?? displayOptions.show3DOverlay;

        if (want3D) {
            try {
                logger.info('AircraftRendererFactory', 'Loading 3D aircraft renderer...');
                const Aircraft3DModule = await import(/* webpackChunkName: "aircraft-3d" */ './Aircraft3DRenderer');
                logger.info('AircraftRendererFactory', '3D aircraft renderer loaded successfully');
                return new Aircraft3DModule.Aircraft3DRenderer(displayOptions, stateManager);
            } catch (error) {
                logger.warn('AircraftRendererFactory', 'Failed to load 3D renderer, falling back to 2D:', error);
            }
        }

        logger.info('AircraftRendererFactory', 'Using 2D aircraft renderer');
        const shapeDrawer = this.getShapeDrawer(displayOptions.aircraftShape);
        return new Aircraft2DRenderer(displayOptions, shapeDrawer, stateManager);
    }

    /**
     * Lazy-load and instantiate the 3D aircraft route renderer.
     * Reuses the "aircraft-3d" webpack chunk so Three.js is loaded once.
     */
    static async createRoute3D(displayOptions: DisplayOptions): Promise<AircraftRoute3DRenderer | null> {
        try {
            logger.info('AircraftRendererFactory', 'Loading 3D route renderer...');
            const module = await import(
                /* webpackChunkName: "aircraft-3d" */ './AircraftRoute3DRenderer'
            );
            logger.info('AircraftRendererFactory', '3D route renderer loaded successfully');
            return new module.AircraftRoute3DRenderer(displayOptions);
        } catch (error) {
            logger.warn('AircraftRendererFactory', 'Failed to load 3D route renderer:', error);
            return null;
        }
    }

    private static getShapeDrawer(shapeType: string): AircraftShapeDrawer {
        const shapeConfig = AIRCRAFT_SHAPES[shapeType as keyof typeof AIRCRAFT_SHAPES];
        return shapeConfig ? shapeConfig.drawer : AIRCRAFT_SHAPES.chevron.drawer;
    }
}
