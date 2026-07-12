/**
 * Tests for AircraftRendererFactory: create2D always returns the 2D renderer,
 * and create3D/createRoute3D return null when the lazy-loaded Three.js chunk
 * fails to load. They must never substitute a 2D renderer on failure — the 2D
 * renderer is always active, so a substitute would be initialized on the map
 * alongside it and collide with its fixed layer/source IDs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DisplayOptions } from '../../../data/types';
import type { StateManager } from '../../../core/StateManager';

const DISPLAY_OPTIONS = { aircraftShape: 'chevron' } as DisplayOptions;
const STATE_MANAGER = {} as StateManager;

beforeEach(() => {
    vi.resetModules();
});

async function loadFactory() {
    return (await import('./AircraftRendererFactory')).AircraftRendererFactory;
}

describe('AircraftRendererFactory.create2D', () => {
    it('returns a 2D renderer', async () => {
        const factory = await loadFactory();
        const renderer = factory.create2D(DISPLAY_OPTIONS, STATE_MANAGER);
        expect(renderer.getType()).toBe('2d');
    });

    it('falls back to the chevron shape for an unknown shape type', async () => {
        const factory = await loadFactory();
        const options = { aircraftShape: 'no-such-shape' } as unknown as DisplayOptions;
        const renderer = factory.create2D(options, STATE_MANAGER);
        expect(renderer.getType()).toBe('2d');
    });
});

describe('AircraftRendererFactory.create3D', () => {
    it('returns the 3D renderer when the chunk loads', async () => {
        vi.doMock('./Aircraft3DRenderer', () => ({
            Aircraft3DRenderer: class {
                constructor(
                    public displayOptions: DisplayOptions,
                    public stateManager: StateManager
                ) {}
                getType(): '3d' {
                    return '3d';
                }
            },
        }));

        const factory = await loadFactory();
        const renderer = await factory.create3D(DISPLAY_OPTIONS, STATE_MANAGER);
        expect(renderer?.getType()).toBe('3d');
    });

    it('returns null (not a 2D substitute) when the chunk fails to load', async () => {
        vi.doMock('./Aircraft3DRenderer', () => {
            throw new Error('chunk load failed');
        });

        const factory = await loadFactory();
        const renderer = await factory.create3D(DISPLAY_OPTIONS, STATE_MANAGER);
        expect(renderer).toBeNull();
    });
});

describe('AircraftRendererFactory.createRoute3D', () => {
    it('returns null when the chunk fails to load', async () => {
        vi.doMock('./AircraftRoute3DRenderer', () => {
            throw new Error('chunk load failed');
        });

        const factory = await loadFactory();
        const renderer = await factory.createRoute3D(DISPLAY_OPTIONS);
        expect(renderer).toBeNull();
    });
});
