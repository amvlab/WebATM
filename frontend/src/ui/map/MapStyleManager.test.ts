// @vitest-environment happy-dom
/**
 * Characterizes the offline-fallback policy in MapStyleManager.handleMapError.
 *
 * The fallback must fire on a genuine style-document network failure (offline
 * boot) but must NOT fire on individual tile fetch failures — a transient or
 * CORS-blocked vector tile while panning should never swap the whole basemap
 * to offline (which flickers the map and, with the 3D overlay on, resets the
 * camera). See the regression this guards against: WebATM map flicker/reset.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Map } from 'maplibre-gl';
import { MapStyleManager } from './MapStyleManager';

const OFFLINE_STYLE = '/static/map/offline-style.json';

function makeMap(): { map: Map; setStyle: ReturnType<typeof vi.fn> } {
    const setStyle = vi.fn();
    const map = { setStyle, once: vi.fn() } as unknown as Map;
    return { map, setStyle };
}

function makeManager(): { mgr: MapStyleManager; setStyle: ReturnType<typeof vi.fn> } {
    localStorage.clear();
    const { map, setStyle } = makeMap();
    const mgr = new MapStyleManager(() => map);
    // Start on the remote default basemap (a https:// style URL).
    mgr.resolveInitialStyle();
    expect(mgr.getCurrentStyle().startsWith('http')).toBe(true);
    return { mgr, setStyle };
}

describe('MapStyleManager offline fallback', () => {
    beforeEach(() => localStorage.clear());

    it('does NOT fall back to offline on an individual tile fetch failure', () => {
        const { mgr, setStyle } = makeManager();

        // MapLibre tile errors carry a `tile` object.
        mgr.handleMapError({
            error: new TypeError('Failed to fetch'),
            sourceId: 'carto',
            tile: { tileID: 'x' },
        });

        expect(setStyle).not.toHaveBeenCalled();
        expect(mgr.getCurrentStyle().startsWith('http')).toBe(true);
    });

    it('DOES fall back to offline on a style-document network failure (no tile)', () => {
        const { mgr, setStyle } = makeManager();

        // Style/source document failure: a network error with no `tile`.
        const err = Object.assign(new Error('Failed to fetch'), { status: 0 });
        mgr.handleMapError({ error: err });

        expect(setStyle).toHaveBeenCalledWith(OFFLINE_STYLE);
        expect(mgr.getCurrentStyle()).toBe(OFFLINE_STYLE);
    });

    it('only falls back once, even on repeated document failures', () => {
        const { mgr, setStyle } = makeManager();
        const err = () => Object.assign(new Error('Failed to fetch'), { status: 0 });

        mgr.handleMapError({ error: err() });
        mgr.handleMapError({ error: err() });

        expect(setStyle).toHaveBeenCalledTimes(1);
    });
});
