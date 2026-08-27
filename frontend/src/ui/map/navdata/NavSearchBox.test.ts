// @vitest-environment happy-dom
/**
 * Tests for NavSearchBox: the setVisible show/hide behaviour behind the
 * "Search Bar" display option, and the stale-response guard in the
 * search/fetch flow (fetch is mocked with manually-resolved promises).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NavSearchBox } from './NavSearchBox';
import type { MapDisplay } from '../MapDisplay';

function mountMarkup(): void {
    document.body.innerHTML = `
        <div id="nav-search" class="nav-search">
            <input id="nav-search-input" type="text">
            <div id="nav-search-results" style="display: none;"></div>
        </div>
    `;
}

function createMapDisplayMock(): MapDisplay {
    return { setCenter: vi.fn() } as unknown as MapDisplay;
}

describe('NavSearchBox.setVisible', () => {
    let box: NavSearchBox;

    beforeEach(() => {
        mountMarkup();
        box = new NavSearchBox(createMapDisplayMock());
        box.init();
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    const container = () => document.getElementById('nav-search') as HTMLElement;
    const results = () => document.getElementById('nav-search-results') as HTMLElement;

    it('hides the search box by setting display:none', () => {
        box.setVisible(false);
        expect(container().style.display).toBe('none');
    });

    it('shows the search box by clearing the inline display', () => {
        box.setVisible(false);
        box.setVisible(true);
        // Empty string reverts to the stylesheet's default (visible).
        expect(container().style.display).toBe('');
    });

    it('closes the results dropdown when hidden', () => {
        // Pretend the dropdown was open.
        results().style.display = 'block';
        box.setVisible(false);
        expect(results().style.display).toBe('none');
    });

    it('is a safe no-op when the markup is absent (init not run)', () => {
        const orphan = new NavSearchBox(createMapDisplayMock());
        expect(() => orphan.setVisible(false)).not.toThrow();
        expect(() => orphan.setVisible(true)).not.toThrow();
    });
});

/** One manually-resolvable in-flight search request. */
function deferredJson() {
    let resolve!: (data: unknown) => void;
    let reject!: (err: unknown) => void;
    const response = new Promise<{ json: () => Promise<unknown> }>((res, rej) => {
        resolve = (data: unknown) => res({ json: async () => data });
        reject = rej;
    });
    return { response, resolve, reject };
}

function result(ident: string) {
    return { kind: 'airport', ident, name: `${ident} airport`, lat: 52, lon: 4, iata: '' };
}

describe('NavSearchBox stale-response handling', () => {
    let box: NavSearchBox;
    let mapDisplay: MapDisplay;
    let pending: ReturnType<typeof deferredJson>[];

    const input = () => document.getElementById('nav-search-input') as HTMLInputElement;
    const results = () => document.getElementById('nav-search-results') as HTMLElement;

    const type = async (text: string) => {
        input().value = text;
        input().dispatchEvent(new Event('input'));
        await vi.advanceTimersByTimeAsync(200); // debounce
    };
    const flush = () => vi.advanceTimersByTimeAsync(0);

    beforeEach(() => {
        vi.useFakeTimers();
        mountMarkup();
        pending = [];
        vi.stubGlobal('fetch', vi.fn(() => {
            const d = deferredJson();
            pending.push(d);
            return d.response;
        }));
        mapDisplay = createMapDisplayMock();
        box = new NavSearchBox(mapDisplay);
        box.init();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('drops a response that arrives after the input was cleared', async () => {
        await type('EHAM');
        expect(pending).toHaveLength(1);

        // User clears the box while the request is still in flight.
        await type('');
        expect(results().style.display).toBe('none');

        pending[0].resolve({ success: true, results: [result('EHAM')] });
        await flush();

        // The dropdown must not re-open over the empty input.
        expect(results().style.display).toBe('none');
        expect(results().querySelectorAll('.nav-search-item')).toHaveLength(0);
    });

    it('keeps the newest results when responses resolve out of order', async () => {
        await type('EH');
        await type('LFPG');
        expect(pending).toHaveLength(2);

        pending[1].resolve({ success: true, results: [result('LFPG')] });
        await flush();
        pending[0].resolve({ success: true, results: [result('EHAM'), result('EHRD')] });
        await flush();

        const items = results().querySelectorAll('.nav-search-item');
        expect(items).toHaveLength(1);
        expect(items[0].textContent).toContain('LFPG');
    });

    it('clears stale results on a failed search so Enter cannot select one', async () => {
        await type('EHAM');
        pending[0].resolve({ success: true, results: [result('EHAM')] });
        await flush();
        expect(results().querySelectorAll('.nav-search-item')).toHaveLength(1);

        await type('EHRD');
        pending[1].reject(new Error('network down'));
        await flush();

        input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(mapDisplay.setCenter).not.toHaveBeenCalled();
    });
});
