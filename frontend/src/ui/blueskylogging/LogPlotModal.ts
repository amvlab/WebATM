/**
 * Quick-look plotting for BlueSky data logs: the "Plot" action in the Output
 * Log file browser opens this modal, which fetches the log file's content and
 * offers three simple views of it — a time series (per-aircraft lines over
 * simulation time), an X-Y plot (e.g. lon vs lat gives a ground track), and a
 * stats/table view. It is deliberately a first look, not a plotting tool:
 * users who want real plots should download the log and use their own tools.
 */
import { logger } from '../../utils/Logger';
import { onDOMReady, escapeHtml, setVisible } from '../../utils/dom';
import { modalManager } from '../ModalManager';
import { LogPlotChart, seriesColor, type NearestHit } from './logPlotChart';
import {
    buildSeries,
    columnStats,
    formatValue,
    parseLogText,
    plotabilityError,
    type ParsedLog,
    type PlotSeries,
} from './logPlotData';

type PlotView = 'timeseries' | 'xy' | 'table';

interface ContentResponse {
    success: boolean;
    content: string;
    error?: string;
}

/** Lines fetched from the (possibly still growing) log file. */
const FETCH_LINES = 20000;
/** Raw rows shown in the table view. */
const TABLE_ROWS = 200;

export class LogPlotModal {
    private chart: LogPlotChart | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private chartWrap: HTMLElement | null = null;
    private tableWrap: HTMLElement | null = null;
    private unplottableEl: HTMLElement | null = null;
    private legendEl: HTMLElement | null = null;
    private readoutEl: HTMLElement | null = null;
    private statusEl: HTMLElement | null = null;
    private filenameEl: HTMLElement | null = null;
    private xSelect: HTMLSelectElement | null = null;
    private ySelect: HTMLSelectElement | null = null;
    private xLabelEl: HTMLElement | null = null;
    private yLabelEl: HTMLElement | null = null;

    private filepath = '';
    // Bumped on every load so a slow response for a previously opened file
    // cannot overwrite the file opened after it.
    private loadGeneration = 0;
    private log: ParsedLog | null = null;
    private view: PlotView = 'timeseries';
    private series: PlotSeries[] = [];
    private hiddenSeries = new Set<string>();
    private isInitialized = false;

    private static readonly MODAL_ID = 'log-plot-modal';

    constructor() {
        onDOMReady(() => this.initializeElements());
    }

    private initializeElements(): void {
        if (this.isInitialized) return;

        this.canvas = document.getElementById('log-plot-canvas') as HTMLCanvasElement | null;
        this.chartWrap = document.getElementById('log-plot-chart-wrap');
        this.tableWrap = document.getElementById('log-plot-table-wrap');
        this.unplottableEl = document.getElementById('log-plot-unplottable');
        this.legendEl = document.getElementById('log-plot-legend');
        this.readoutEl = document.getElementById('log-plot-readout');
        this.statusEl = document.getElementById('log-plot-status');
        this.filenameEl = document.getElementById('log-plot-filename');
        this.xSelect = document.getElementById('log-plot-x-select') as HTMLSelectElement | null;
        this.ySelect = document.getElementById('log-plot-y-select') as HTMLSelectElement | null;
        this.xLabelEl = document.getElementById('log-plot-x-label');
        this.yLabelEl = document.getElementById('log-plot-y-label');

        if (this.canvas) {
            this.chart = new LogPlotChart(this.canvas);
            this.canvas.addEventListener('mousemove', (e) => this.onHover(e));
            this.canvas.addEventListener('mouseleave', () => this.hideReadout());
        }
        if (this.chartWrap && 'ResizeObserver' in window) {
            new ResizeObserver(() => this.chart?.draw()).observe(this.chartWrap);
        }

        document.querySelectorAll<HTMLElement>('#log-plot-modal .log-plot-tab').forEach(tab => {
            tab.addEventListener('click', () => this.switchView((tab.dataset.view as PlotView) || 'timeseries'));
        });
        this.xSelect?.addEventListener('change', () => this.render());
        this.ySelect?.addEventListener('change', () => this.render());
        document.getElementById('log-plot-reload-btn')
            ?.addEventListener('click', () => void this.load());
        document.getElementById('log-plot-download-btn')
            ?.addEventListener('click', () => window.logStreamManager?.downloadFile(this.filepath));

        // Legend interactions (event delegation): chips toggle one aircraft,
        // shift-click isolates it, and the All/None buttons bulk-select — the
        // point of the legend in a simulation with many aircraft.
        this.legendEl?.addEventListener('click', (e) => {
            const target = e.target as HTMLElement | null;
            const action = (target?.closest('[data-action]') as HTMLElement | null)?.dataset.action;
            if (action === 'show-all') {
                this.hiddenSeries.clear();
                this.render();
                return;
            }
            if (action === 'hide-all') {
                this.series.forEach(s => this.hiddenSeries.add(s.label));
                this.render();
                return;
            }
            const chip = target?.closest('[data-series]') as HTMLElement | null;
            if (!chip) return;
            const label = chip.dataset.series || '';
            if (e.shiftKey) {
                this.soloSeries(label);
            } else if (this.hiddenSeries.has(label)) {
                this.hiddenSeries.delete(label);
            } else {
                this.hiddenSeries.add(label);
            }
            this.render();
        });

        this.isInitialized = true;
        logger.debug('LogPlotModal', 'Initialized');
    }

    /** Open the modal and plot the output file at `filepath`. */
    public open(filepath: string): void {
        if (!modalManager.getRegisteredModals().includes(LogPlotModal.MODAL_ID)) {
            modalManager.registerModal(LogPlotModal.MODAL_ID);
        }
        this.filepath = filepath;
        this.hiddenSeries.clear();
        if (this.filenameEl) {
            this.filenameEl.textContent = filepath.split('/').pop() || filepath;
        }
        this.setStatus('Loading…');
        modalManager.open(LogPlotModal.MODAL_ID);
        void this.load();
    }

    private async load(): Promise<void> {
        if (!this.filepath) return;
        const generation = ++this.loadGeneration;
        try {
            const encodedPath = encodeURIComponent(this.filepath);
            // include_header keeps the '#' header (column names) that a plain
            // tail of a log longer than FETCH_LINES would cut off.
            const response = await fetch(
                `/api/bluesky/output/content/${encodedPath}?lines=${FETCH_LINES}&include_header=1`);
            const result: ContentResponse = await response.json();
            if (generation !== this.loadGeneration) return; // a newer load won
            if (!result.success) {
                this.log = null;
                this.setStatus(`Could not read file: ${result.error ?? 'unknown error'}`);
                this.render();
                return;
            }
            this.log = parseLogText(result.content);
            this.applyDefaultColumns();
            this.render();
        } catch (error) {
            if (generation !== this.loadGeneration) return;
            logger.error('LogPlotModal', 'Failed to load log file:', error);
            this.log = null;
            this.setStatus('Failed to load file');
            this.render();
        }
    }

    private numericColumns(): number[] {
        if (!this.log) return [];
        return this.log.columns
            .map((col, index) => (col.numeric ? index : -1))
            .filter(index => index !== -1);
    }

    /**
     * Populate the X/Y selects with the numeric columns and pick sensible
     * defaults: time series uses the first numeric column (simt) as X and the
     * first other numeric column as Y; the X-Y view prefers a lon/lat pair
     * (a ground track) when the column names reveal one.
     */
    private applyDefaultColumns(): void {
        if (!this.log || !this.xSelect || !this.ySelect) return;
        const numeric = this.numericColumns();

        const optionsHtml = numeric.map(index =>
            `<option value="${index}">${escapeHtml(this.log!.columns[index].name)}</option>`).join('');
        this.xSelect.innerHTML = optionsHtml;
        this.ySelect.innerHTML = optionsHtml;

        const byName = (pattern: RegExp): number =>
            numeric.find(i => pattern.test(this.log!.columns[i].name)) ?? -1;

        if (this.view === 'xy') {
            const lon = byName(/lon/i);
            const lat = byName(/lat/i);
            this.xSelect.value = String(lon !== -1 ? lon : numeric[0] ?? 0);
            this.ySelect.value = String(lat !== -1 ? lat : numeric[1] ?? numeric[0] ?? 0);
        } else {
            this.xSelect.value = String(numeric[0] ?? 0);
            this.ySelect.value = String(numeric[1] ?? numeric[0] ?? 0);
        }
    }

    private switchView(view: PlotView): void {
        if (view === this.view) return;
        this.view = view;
        document.querySelectorAll<HTMLElement>('#log-plot-modal .log-plot-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.view === view);
        });
        this.applyDefaultColumns();
        this.render();
    }

    private render(): void {
        this.hideReadout();

        if (!this.log) {
            // Fetch failed; the status line already carries the error.
            this.showPanels({ chart: false, table: false, unplottable: false });
            return;
        }

        // Event logs (CONFLOG/FLSTLOG) can't be drawn — say so instead of
        // plotting something misleading.
        const reason = plotabilityError(this.log);
        if (reason) {
            this.renderUnplottable(reason);
            return;
        }

        const isTable = this.view === 'table';
        this.showPanels({ chart: !isTable, table: isTable, unplottable: false });
        if (isTable) {
            if (this.legendEl) this.legendEl.innerHTML = '';
            this.renderTable();
        } else {
            this.renderChart();
        }
        this.updateStatus();
    }

    private showPanels(visible: { chart: boolean; table: boolean; unplottable: boolean }): void {
        if (this.chartWrap) setVisible(this.chartWrap, visible.chart);
        if (this.tableWrap) setVisible(this.tableWrap, visible.table);
        if (this.unplottableEl) setVisible(this.unplottableEl, visible.unplottable);
        // The time-series X axis is always the first numeric column (simt)
        if (this.xLabelEl) setVisible(this.xLabelEl, visible.chart && this.view === 'xy');
        if (this.yLabelEl) setVisible(this.yLabelEl, visible.chart);
        if (!visible.chart && this.legendEl) this.legendEl.innerHTML = '';
    }

    private renderUnplottable(reason: string): void {
        if (!this.log) return;
        this.showPanels({ chart: false, table: false, unplottable: true });
        if (this.unplottableEl) {
            this.unplottableEl.textContent =
                `This file can't be plotted: ${reason}. The quick-look plot only understands ` +
                'periodic data logs (CRELOG: simulation time first, one row per aircraft per ' +
                'interval) — use Stream to view this file, or Download it to analyze it with ' +
                'your own tools.';
        }
        this.setStatus(
            `${this.log.rows.length} rows × ${this.log.columns.length} columns · not a plottable periodic log`);
    }

    private selectedColumn(select: HTMLSelectElement | null): number {
        const value = parseInt(select?.value ?? '', 10);
        return Number.isFinite(value) ? value : -1;
    }

    private renderChart(): void {
        if (!this.log || !this.chart) return;
        const numeric = this.numericColumns();
        const xCol = this.view === 'xy' ? this.selectedColumn(this.xSelect) : (numeric[0] ?? -1);
        const yCol = this.selectedColumn(this.ySelect);
        if (xCol === -1 || yCol === -1) {
            this.series = [];
            this.chart.setData([], { mode: 'line', xLabel: '', yLabel: '' });
            this.chart.draw();
            if (this.legendEl) this.legendEl.innerHTML = '';
            return;
        }

        this.series = buildSeries(this.log, xCol, yCol);
        const allHidden = this.series.length > 0 &&
            this.series.every(s => this.hiddenSeries.has(s.label));
        this.chart.setData(this.series, {
            mode: this.view === 'xy' ? 'scatter' : 'line',
            xLabel: this.log.columns[xCol].name,
            yLabel: this.log.columns[yCol].name,
            emptyMessage: allHidden
                ? 'All aircraft hidden — pick one in the legend above'
                : undefined,
        });
        this.chart.setHidden(this.hiddenSeries);
        this.renderLegend();
        // Draw on the next frame so a just-opened modal has layout/size
        requestAnimationFrame(() => this.chart?.draw());
    }

    /**
     * Isolate one aircraft: hide every other series. Shift-clicking the only
     * visible series brings everything back, so the gesture is reversible in
     * place.
     */
    private soloSeries(label: string): void {
        const visible = this.series.filter(s => !this.hiddenSeries.has(s.label));
        if (visible.length === 1 && visible[0].label === label) {
            this.hiddenSeries.clear();
            return;
        }
        this.series.forEach(s => {
            if (s.label === label) this.hiddenSeries.delete(s.label);
            else this.hiddenSeries.add(s.label);
        });
    }

    private renderLegend(): void {
        if (!this.legendEl) return;
        if (this.series.length <= 1) {
            this.legendEl.innerHTML = '';
            return;
        }
        const visibleCount = this.series.filter(s => !this.hiddenSeries.has(s.label)).length;
        const controls = `
            <span class="log-plot-legend-actions">
                <button class="console-btn" data-action="show-all" title="Show every aircraft">All</button>
                <button class="console-btn" data-action="hide-all" title="Hide every aircraft (then pick the ones to compare)">None</button>
                <span class="log-plot-legend-count">${visibleCount}/${this.series.length}</span>
            </span>`;
        const chips = this.series.map((s, index) => `
            <span class="log-plot-legend-chip ${this.hiddenSeries.has(s.label) ? 'hidden-series' : ''}"
                  data-series="${escapeHtml(s.label)}" title="Click to show/hide - Shift-click to show only ${escapeHtml(s.label)}">
                <span class="log-plot-legend-dot" style="background:${seriesColor(index)}"></span>${escapeHtml(s.label)}
            </span>`).join('');
        this.legendEl.innerHTML = controls + chips;
    }

    private renderTable(): void {
        if (!this.log || !this.tableWrap) return;
        const { columns, rows } = this.log;

        const statsRows = columns.map((col, index) => {
            const stats = columnStats(this.log!, index);
            if (!stats) return '';
            return `
                <tr>
                    <td class="log-plot-col-name">${escapeHtml(col.name)}</td>
                    <td>${stats.count}</td>
                    <td>${formatValue(stats.min)}</td>
                    <td>${formatValue(stats.mean)}</td>
                    <td>${formatValue(stats.max)}</td>
                </tr>`;
        }).join('');

        const preview = rows.slice(-TABLE_ROWS);
        const headerHtml = columns.map(c => `<th>${escapeHtml(c.name)}</th>`).join('');
        const bodyHtml = preview.map(row => `
            <tr>${row.map(cell => `<td>${escapeHtml(
                typeof cell === 'number' ? formatValue(cell) : String(cell))}</td>`).join('')}</tr>`).join('');

        this.tableWrap.innerHTML = `
            <h4>Column statistics</h4>
            <table class="log-plot-table">
                <thead><tr><th>Column</th><th>Count</th><th>Min</th><th>Mean</th><th>Max</th></tr></thead>
                <tbody>${statsRows}</tbody>
            </table>
            <h4>Data${rows.length > TABLE_ROWS ? ` (last ${TABLE_ROWS} of ${rows.length} rows)` : ''}</h4>
            <table class="log-plot-table">
                <thead><tr>${headerHtml}</tr></thead>
                <tbody>${bodyHtml}</tbody>
            </table>`;
    }

    private updateStatus(): void {
        if (!this.log) return;
        const parts = [
            `${this.log.rows.length} rows × ${this.log.columns.length} columns`,
        ];
        if (this.log.groupColumn !== null && this.series.length > 0 && this.view !== 'table') {
            parts.push(`${this.series.length} series (${this.log.columns[this.log.groupColumn].name})`);
        }
        if (this.log.skipped > 0) {
            parts.push(`${this.log.skipped} malformed rows skipped`);
        }
        parts.push('quick look only — Download the file for your own analysis');
        this.setStatus(parts.join(' · '));
    }

    private setStatus(text: string): void {
        if (this.statusEl) this.statusEl.textContent = text;
    }

    // --- Hover readout ---

    private hoverActive = false;

    private onHover(e: MouseEvent): void {
        if (!this.chart || this.view === 'table') return;
        const hit = this.chart.nearest(e.offsetX, e.offsetY);
        if (!hit && !this.hoverActive) return; // nothing highlighted, nothing to clear
        this.hoverActive = hit !== null;
        this.chart.setHighlight(hit);
        this.chart.draw();
        this.showReadout(hit);
    }

    private showReadout(hit: NearestHit | null): void {
        if (!this.readoutEl || !this.log) return;
        if (!hit) {
            this.hideReadout();
            return;
        }
        const label = this.series.length > 1 ? `${hit.series.label}: ` : '';
        this.readoutEl.textContent =
            `${label}${formatValue(hit.point.x)}, ${formatValue(hit.point.y)}`;
        this.readoutEl.style.display = '';
        // Keep the readout inside the chart area (flip it left of the cursor
        // near the right edge).
        const wrapWidth = this.chartWrap?.clientWidth ?? 0;
        const flip = hit.px > wrapWidth - 160;
        this.readoutEl.style.left = flip ? '' : `${hit.px + 12}px`;
        this.readoutEl.style.right = flip ? `${wrapWidth - hit.px + 12}px` : '';
        this.readoutEl.style.top = `${Math.max(4, hit.py - 24)}px`;
    }

    private hideReadout(): void {
        if (this.readoutEl) this.readoutEl.style.display = 'none';
        if (this.chart && this.hoverActive) {
            this.hoverActive = false;
            this.chart.setHighlight(null);
            this.chart.draw();
        }
    }
}

export const logPlotModal = new LogPlotModal();

// Exposed on window so the Output Log file browser can open it for a file;
// typed in types/globals.d.ts.
window.logPlotModal = logPlotModal;
