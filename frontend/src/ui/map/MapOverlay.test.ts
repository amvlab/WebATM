// @vitest-environment happy-dom
/**
 * Regression tests for MapOverlay's 3D overlay lifecycle: when the 3D
 * renderer chunk fails to load (factory returns null) the overlay must stay
 * off — the old factory fell back to a second 2D renderer, which MapOverlay
 * then initialized over the always-active one, colliding with its fixed map
 * layer IDs and marking the overlay active with no 3D renderer behind it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { DisplayOptions, AircraftData } from '../../data/types';
import type { StateManager } from '../../core/StateManager';
import type { MapDisplay } from './MapDisplay';
import type { IEntityRenderer } from './rendering/IEntityRenderer';
import { MapOverlay } from './MapOverlay';
import { AircraftRendererFactory } from './aircraft/AircraftRendererFactory';

vi.mock('./aircraft/AircraftRendererFactory', () => ({
    AircraftRendererFactory: {
        create2D: vi.fn(),
        create3D: vi.fn(),
        createRoute3D: vi.fn().mockResolvedValue(null),
    },
}));

function makeMap(): MapLibreMap {
    return {
        getCenter: () => ({ lng: 0, lat: 0 }),
        getZoom: () => 5,
        getPitch: () => 0,
        getBearing: () => 0,
        on: vi.fn(),
        once: vi.fn(),
    } as unknown as MapLibreMap;
}

function makeMapDisplay(map: MapLibreMap): MapDisplay {
    return {
        getMap: () => map,
        resize: vi.fn(),
        isInitialized: () => true,
        getProjection: () => 'mercator',
    } as unknown as MapDisplay;
}

function makeStateManager(): StateManager {
    return {
        getState: () => ({ selectedAircraft: null, aircraftData: null, simInfo: null }),
        getDisplayOptions: () => ({}) as DisplayOptions,
    } as unknown as StateManager;
}

function make3DRenderer(): IEntityRenderer<AircraftData> {
    return {
        initialize: vi.fn(),
        updateEntities: vi.fn(),
        updateDisplayOptions: vi.fn(),
        onStyleChange: vi.fn(),
        destroy: vi.fn(),
        getType: () => '3d' as const,
    };
}

describe('MapOverlay 3D overlay lifecycle', () => {
    let overlay: MapOverlay;
    let map: MapLibreMap;

    beforeEach(() => {
        vi.mocked(AircraftRendererFactory.create3D).mockReset();
        map = makeMap();
        overlay = new MapOverlay(makeMapDisplay(map), makeStateManager());
    });

    it('leaves the overlay off when the 3D renderer fails to load', async () => {
        vi.mocked(AircraftRendererFactory.create3D).mockResolvedValue(null);

        await overlay.updateDisplayOptions({ show3DOverlay: true });
        expect(AircraftRendererFactory.create3D).toHaveBeenCalledTimes(1);

        // The overlay must not be stuck "active": a retry attempts the load again.
        await overlay.updateDisplayOptions({ show3DOverlay: true });
        expect(AircraftRendererFactory.create3D).toHaveBeenCalledTimes(2);
    });

    it('enables the overlay once and tears it down on disable', async () => {
        const renderer3D = make3DRenderer();
        vi.mocked(AircraftRendererFactory.create3D).mockResolvedValue(renderer3D);

        await overlay.updateDisplayOptions({ show3DOverlay: true });
        expect(renderer3D.initialize).toHaveBeenCalledWith(map);

        // Already active: a second enable must not create another renderer.
        await overlay.updateDisplayOptions({ show3DOverlay: true });
        expect(AircraftRendererFactory.create3D).toHaveBeenCalledTimes(1);

        await overlay.updateDisplayOptions({ show3DOverlay: false });
        expect(renderer3D.destroy).toHaveBeenCalledTimes(1);
    });
});
