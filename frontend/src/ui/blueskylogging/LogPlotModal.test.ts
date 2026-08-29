// @vitest-environment happy-dom
/**
 * Log Plot modal: aircraft (series) selection via the legend — per-chip
 * toggling, the All/None bulk buttons, and shift-click isolation — plus the
 * shown-count readout. Chart pixels are not asserted (happy-dom has no
 * canvas); the visibility state driving them is.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LogPlotModal } from './LogPlotModal';

const SAMPLE = [
    '# simt, id, lat, lon, alt',
    '1,KL001,52.1,4.1,3000',
    '1,KL002,52.2,4.2,4000',
    '1,AF265,52.3,4.3,5000',
    '2,KL001,52.11,4.11,3010',
    '2,KL002,52.21,4.21,4010',
    '2,AF265,52.31,4.31,5010',
].join('\n');

function buildDom(): void {
    document.body.innerHTML = `
        <div id="log-plot-modal" class="modal" style="display: none;">
            <button class="modal-close" id="log-plot-modal-close">&times;</button>
            <span id="log-plot-filename"></span>
            <button class="log-plot-tab active" data-view="timeseries">Time Series</button>
            <button class="log-plot-tab" data-view="xy">X-Y Plot</button>
            <button class="log-plot-tab" data-view="table">Data &amp; Stats</button>
            <label id="log-plot-x-label" style="display: none;">X:
                <select id="log-plot-x-select"></select></label>
            <label id="log-plot-y-label">Y:
                <select id="log-plot-y-select"></select></label>
            <button id="log-plot-reload-btn">Reload</button>
            <button id="log-plot-download-btn">Download</button>
            <div id="log-plot-legend"></div>
            <div id="log-plot-chart-wrap">
                <canvas id="log-plot-canvas"></canvas>
                <div id="log-plot-readout" style="display: none;"></div>
            </div>
            <div id="log-plot-table-wrap" style="display: none;"></div>
            <div id="log-plot-unplottable" style="display: none;"></div>
            <div id="log-plot-status"></div>
        </div>
    `;
}

const chips = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('.log-plot-legend-chip'));
const chip = (label: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`.log-plot-legend-chip[data-series="${label}"]`);
const visibleLabels = (): string[] =>
    chips().filter(c => !c.classList.contains('hidden-series')).map(c => c.dataset.series || '');
const countText = (): string =>
    document.querySelector('.log-plot-legend-count')?.textContent ?? '';

describe('LogPlotModal aircraft selection', () => {
    beforeEach(() => {
        vi.resetModules(); // fresh singletons (modalManager, logPlotModal)
        buildDom();
        vi.stubGlobal('fetch', vi.fn(async () => ({
            json: async () => ({ success: true, content: SAMPLE }),
        })));
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    async function boot(): Promise<LogPlotModal> {
        const module = await import('./LogPlotModal');
        const modal = module.logPlotModal;
        modal.open('output/MYLOG.log');
        await vi.waitFor(() => expect(chips()).toHaveLength(3));
        return modal;
    }

    it('renders one legend chip per aircraft plus All/None and a count', async () => {
        await boot();
        expect(chips().map(c => c.dataset.series)).toEqual(['KL001', 'KL002', 'AF265']);
        expect(document.querySelector('[data-action="show-all"]')).not.toBeNull();
        expect(document.querySelector('[data-action="hide-all"]')).not.toBeNull();
        expect(countText()).toBe('3/3');
    });

    it('click toggles a single aircraft off and back on', async () => {
        await boot();
        chip('KL002')!.click();
        expect(visibleLabels()).toEqual(['KL001', 'AF265']);
        expect(countText()).toBe('2/3');
        chip('KL002')!.click();
        expect(visibleLabels()).toEqual(['KL001', 'KL002', 'AF265']);
        expect(countText()).toBe('3/3');
    });

    it('None hides every aircraft and All restores them', async () => {
        await boot();
        (document.querySelector('[data-action="hide-all"]') as HTMLElement).click();
        expect(visibleLabels()).toEqual([]);
        expect(countText()).toBe('0/3');
        // Picking aircraft back one at a time is the many-aircraft workflow
        chip('AF265')!.click();
        expect(visibleLabels()).toEqual(['AF265']);
        (document.querySelector('[data-action="show-all"]') as HTMLElement).click();
        expect(countText()).toBe('3/3');
    });

    it('shift-click isolates one aircraft; shift-click again restores all', async () => {
        await boot();
        const shiftClick = (el: HTMLElement) => el.dispatchEvent(
            new MouseEvent('click', { bubbles: true, shiftKey: true }));
        shiftClick(chip('KL002')!);
        expect(visibleLabels()).toEqual(['KL002']);
        expect(countText()).toBe('1/3');
        shiftClick(chip('KL002')!);
        expect(visibleLabels()).toEqual(['KL001', 'KL002', 'AF265']);
    });

    it('keeps the selection when switching to the X-Y view', async () => {
        await boot();
        chip('KL001')!.click();
        (document.querySelector('.log-plot-tab[data-view="xy"]') as HTMLElement).click();
        await vi.waitFor(() => expect(chips()).toHaveLength(3));
        expect(visibleLabels()).toEqual(['KL002', 'AF265']);
    });

    it('says a CONFLOG-style event log cannot be plotted instead of charting it', async () => {
        const conflog = ['# CONF LOG', '# simt', '123.00000000,1', '245.50000000,3'].join('\n');
        vi.stubGlobal('fetch', vi.fn(async () => ({
            json: async () => ({ success: true, content: conflog }),
        })));
        const module = await import('./LogPlotModal');
        module.logPlotModal.open('output/CONFLOG.log');

        const messageEl = document.getElementById('log-plot-unplottable') as HTMLElement;
        await vi.waitFor(() => expect(messageEl.style.display).not.toBe('none'));
        expect(messageEl.textContent).toMatch(/can't be plotted/);
        expect(messageEl.textContent).toMatch(/Download/);
        // No chart, table, or legend is offered for it
        expect((document.getElementById('log-plot-chart-wrap') as HTMLElement).style.display).toBe('none');
        expect((document.getElementById('log-plot-table-wrap') as HTMLElement).style.display).toBe('none');
        expect(chips()).toHaveLength(0);
        expect(document.getElementById('log-plot-status')!.textContent).toMatch(/not a plottable periodic log/);
    });

    it('resets the selection when opening another file', async () => {
        const modal = await boot();
        chip('KL001')!.click();
        expect(countText()).toBe('2/3');
        modal.open('output/OTHER.log');
        await vi.waitFor(() => expect(countText()).toBe('3/3'));
    });
});
