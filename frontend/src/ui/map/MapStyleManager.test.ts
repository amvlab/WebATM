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

function makeMap(): { map: Map; setStyle: ReturnType<typeof vi.fn>; once: ReturnType<typeof vi.fn> } {
    const setStyle = vi.fn();
    const once = vi.fn();
    const map = { setStyle, once, isStyleLoaded: () => false } as unknown as Map;
    return { map, setStyle, once };
}

function makeManager(): {
    mgr: MapStyleManager;
    setStyle: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
} {
    localStorage.clear();
    const { map, setStyle, once } = makeMap();
    const mgr = new MapStyleManager(() => map);
    // Start on the remote default basemap (a https:// style URL).
    mgr.resolveInitialStyle();
    expect(mgr.getCurrentStyle().startsWith('http')).toBe(true);
    return { mgr, setStyle, once };
}

/** Let the probe's promise chain settle (it has no timer on the happy path). */
async function flushProbe(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
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

/**
 * Characterizes the deterministic first-load fallback (armFirstLoadFallback).
 *
 * On an air-gapped network the remote style request often *hangs* instead of
 * rejecting — no MapLibre 'error' event ever fires, so the handleMapError
 * fallback never runs and the first load stays blank until the browser's
 * connect timeout (minutes). The probe makes that first load recover in
 * seconds regardless of how the network fails.
 */
describe('MapStyleManager first-load probe fallback', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('falls back to offline when the probe fetch rejects', async () => {
        const { mgr, setStyle } = makeManager();
        vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));

        mgr.armFirstLoadFallback();
        await flushProbe();

        expect(setStyle).toHaveBeenCalledWith(OFFLINE_STYLE);
        expect(mgr.getCurrentStyle()).toBe(OFFLINE_STYLE);
    });

    it('falls back to offline when the probe request hangs past the timeout', async () => {
        vi.useFakeTimers();
        const { mgr, setStyle } = makeManager();
        // A fetch that never resolves on its own, only rejects on abort —
        // the air-gapped "request hangs forever" shape.
        vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () =>
                    reject(new DOMException('The operation was aborted', 'AbortError')));
            })
        ));

        mgr.armFirstLoadFallback();
        await vi.advanceTimersByTimeAsync(5000);
        await flushProbe();

        expect(setStyle).toHaveBeenCalledWith(OFFLINE_STYLE);
        expect(mgr.getCurrentStyle()).toBe(OFFLINE_STYLE);
        vi.useRealTimers();
    });

    it('does nothing when the probe succeeds', async () => {
        const { mgr, setStyle } = makeManager();
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true } as Response)));

        mgr.armFirstLoadFallback();
        await flushProbe();

        expect(setStyle).not.toHaveBeenCalled();
        expect(mgr.getCurrentStyle().startsWith('http')).toBe(true);
    });

    it('does nothing when the style loaded before the probe settled', async () => {
        const { mgr, setStyle, once } = makeManager();
        let rejectFetch: (err: unknown) => void = () => {};
        vi.stubGlobal('fetch', vi.fn(() => new Promise((_resolve, reject) => {
            rejectFetch = reject;
        })));

        mgr.armFirstLoadFallback();
        // The remote style finishes loading (style.load) while the probe is
        // still in flight; a late probe failure must not swap the style.
        const styleLoadHandler = once.mock.calls.find((c) => c[0] === 'style.load')?.[1];
        styleLoadHandler?.();
        rejectFetch(new TypeError('Failed to fetch'));
        await flushProbe();

        expect(setStyle).not.toHaveBeenCalled();
    });

    it('does not arm the probe when booting on a local (offline) style', () => {
        localStorage.clear();
        const { map, setStyle } = makeMap();
        const mgr = new MapStyleManager(() => map);
        localStorage.setItem('webatm-webatm-map-style', JSON.stringify(OFFLINE_STYLE));
        mgr.resolveInitialStyle();
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        mgr.armFirstLoadFallback();

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(setStyle).not.toHaveBeenCalled();
    });
});
