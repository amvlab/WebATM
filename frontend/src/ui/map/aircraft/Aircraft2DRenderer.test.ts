/**
 * Tests for the Aircraft2DRenderer wrapper: it derives the shape drawer from
 * the display options it is given (both at initialize time and when the
 * aircraft shape changes at runtime), and forwards batch aircraft data to the
 * wrapped AircraftRenderer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { AircraftData, DisplayOptions } from '../../../data/types';
import type { StateManager } from '../../../core/StateManager';
import { Aircraft2DRenderer } from './Aircraft2DRenderer';
import { AIRCRAFT_SHAPES } from './AircraftShapes';

const constructorArgs = vi.fn();
const initialize = vi.fn();
const updateAircraftDisplay = vi.fn();
const updateDisplayOptions = vi.fn();
const setAircraftShape = vi.fn();

vi.mock('./AircraftRenderer', () => ({
    AircraftRenderer: class {
        constructor(...args: unknown[]) {
            constructorArgs(...args);
        }
        initialize = initialize;
        updateAircraftDisplay = updateAircraftDisplay;
        updateDisplayOptions = updateDisplayOptions;
        setAircraftShape = setAircraftShape;
    },
}));

const MAP = {} as MapLibreMap;
const STATE_MANAGER = {} as StateManager;

function options(shape: DisplayOptions['aircraftShape']): DisplayOptions {
    return { aircraftShape: shape } as DisplayOptions;
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('Aircraft2DRenderer', () => {
    it('initializes the wrapped renderer with the drawer for the configured shape', () => {
        const renderer = new Aircraft2DRenderer(options('drone'), STATE_MANAGER);
        renderer.initialize(MAP);

        expect(constructorArgs).toHaveBeenCalledWith(
            MAP,
            options('drone'),
            AIRCRAFT_SHAPES.drone.drawer,
            STATE_MANAGER
        );
        expect(initialize).toHaveBeenCalledOnce();
    });

    it('updates the shape drawer when the aircraft shape changes', () => {
        const renderer = new Aircraft2DRenderer(options('chevron'), STATE_MANAGER);
        renderer.initialize(MAP);

        renderer.updateDisplayOptions(options('triangle'));

        expect(updateDisplayOptions).toHaveBeenCalledWith(options('triangle'));
        expect(setAircraftShape).toHaveBeenCalledWith(AIRCRAFT_SHAPES.triangle.drawer);
    });

    it('does not touch the shape drawer when the shape is unchanged', () => {
        const renderer = new Aircraft2DRenderer(options('chevron'), STATE_MANAGER);
        renderer.initialize(MAP);

        renderer.updateDisplayOptions(options('chevron'));

        expect(updateDisplayOptions).toHaveBeenCalledOnce();
        expect(setAircraftShape).not.toHaveBeenCalled();
    });

    it('remembers a shape change made before initialize', () => {
        const renderer = new Aircraft2DRenderer(options('chevron'), STATE_MANAGER);
        renderer.updateDisplayOptions(options('drone'));
        renderer.initialize(MAP);

        expect(constructorArgs).toHaveBeenCalledWith(
            MAP,
            options('drone'),
            AIRCRAFT_SHAPES.drone.drawer,
            STATE_MANAGER
        );
    });

    it('forwards the batch entry to updateAircraftDisplay', () => {
        const renderer = new Aircraft2DRenderer(options('chevron'), STATE_MANAGER);
        renderer.initialize(MAP);

        const data = { id: ['KL204'] } as AircraftData;
        renderer.updateEntities(new Map([['batch', data]]), 0);

        expect(updateAircraftDisplay).toHaveBeenCalledWith(data);
    });

    it('ignores updates before initialize instead of throwing', () => {
        const renderer = new Aircraft2DRenderer(options('chevron'), STATE_MANAGER);
        const data = { id: ['KL204'] } as AircraftData;

        expect(() => renderer.updateEntities(new Map([['batch', data]]), 0)).not.toThrow();
        expect(updateAircraftDisplay).not.toHaveBeenCalled();
    });
});
