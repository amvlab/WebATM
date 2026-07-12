// @vitest-environment happy-dom
/**
 * Tests for the shared 3D model catalog fetch + dropdown builder.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    fetchAircraftModels,
    populateModelSelect,
    resetAircraftModelsCache,
} from './aircraftModels';
import { AUTO_MODEL_SENTINEL } from './aircraftCategories';

const MODELS = [
    { filename: 'A320.glb', displayName: 'Airbus A320' },
    { filename: 'B747.glb', displayName: 'Boeing 747' },
];

describe('fetchAircraftModels', () => {
    beforeEach(() => {
        resetAircraftModelsCache();
        vi.restoreAllMocks();
    });

    it('fetches the catalog once and caches it', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: true, models: MODELS }),
        });
        vi.stubGlobal('fetch', fetchMock);

        expect(await fetchAircraftModels()).toEqual(MODELS);
        expect(await fetchAircraftModels()).toEqual(MODELS);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('shares one request between concurrent callers', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: true, models: MODELS }),
        });
        vi.stubGlobal('fetch', fetchMock);

        // Both panels kick off the fetch at startup before either resolves
        const [a, b] = await Promise.all([
            fetchAircraftModels(),
            fetchAircraftModels(),
        ]);
        expect(a).toEqual(MODELS);
        expect(b).toEqual(MODELS);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns an empty list on HTTP failure without caching it', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: false });
        vi.stubGlobal('fetch', fetchMock);

        expect(await fetchAircraftModels()).toEqual([]);
        // A later call retries rather than caching the failure
        expect(await fetchAircraftModels()).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('returns an empty list when the request throws', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        expect(await fetchAircraftModels()).toEqual([]);
    });
});

describe('populateModelSelect', () => {
    let select: HTMLSelectElement;

    beforeEach(() => {
        select = document.createElement('select');
    });

    it('builds Auto plus one option per model', () => {
        populateModelSelect(select, MODELS);
        expect(Array.from(select.options).map(o => o.value)).toEqual([
            AUTO_MODEL_SENTINEL, 'A320.glb', 'B747.glb',
        ]);
        expect(select.options[0].textContent).toBe('Auto (by aircraft type)');
        expect(select.value).toBe(AUTO_MODEL_SENTINEL);
    });

    it('selects a known model', () => {
        populateModelSelect(select, MODELS, 'B747.glb');
        expect(select.value).toBe('B747.glb');
    });

    it('falls back to Auto for an unknown saved model', () => {
        populateModelSelect(select, MODELS, 'GONE.glb');
        expect(select.value).toBe(AUTO_MODEL_SENTINEL);
    });
});
