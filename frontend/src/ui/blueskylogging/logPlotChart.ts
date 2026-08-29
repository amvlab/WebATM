/**
 * Minimal dependency-free canvas chart for the Log Plot modal: line or
 * scatter rendering of PlotSeries with axes, grid, and nearest-point lookup
 * for the hover readout. Deliberately simple — the modal is a quick first
 * look at a data log, not a full plotting tool.
 */
import type { PlotSeries, SeriesPoint } from './logPlotData';
import { formatValue } from './logPlotData';

/** Per-series colors; chosen to read on both the light and dark theme. */
export const SERIES_COLORS = [
    '#2196f3', '#ff9800', '#4caf50', '#e91e63', '#9c27b0', '#00bcd4',
    '#cddc39', '#f44336', '#3f51b5', '#ffc107', '#009688', '#795548',
] as const;

export function seriesColor(index: number): string {
    return SERIES_COLORS[index % SERIES_COLORS.length];
}

export interface ChartOptions {
    mode: 'line' | 'scatter';
    xLabel: string;
    yLabel: string;
    /** Shown when nothing is drawable (default 'No plottable data'). */
    emptyMessage?: string;
}

interface Bounds {
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
}

export interface NearestHit {
    seriesIndex: number;
    series: PlotSeries;
    point: SeriesPoint;
    /** CSS-pixel position of the point inside the canvas. */
    px: number;
    py: number;
}

const MARGIN = { top: 12, right: 16, bottom: 34, left: 58 };
/** Per-series cap on drawn/hit-tested points (stride-sampled above it). */
const MAX_DRAW_POINTS = 4000;
const HOVER_RADIUS_PX = 24;

/** Theme-following chart colors, resolved from the app's CSS variables. */
function themeColor(variable: string, fallback: string): string {
    const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
    return value || fallback;
}

/** ~`count` round tick values spanning [min, max]. */
export function niceTicks(min: number, max: number, count: number = 6): number[] {
    if (!Number.isFinite(min) || !Number.isFinite(max) || count < 2) return [];
    if (min === max) {
        const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.05 : 1;
        min -= pad;
        max += pad;
    }
    const rawStep = (max - min) / count;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const residual = rawStep / magnitude;
    const step = (residual >= 5 ? 5 : residual >= 2 ? 2 : 1) * magnitude;
    const ticks: number[] = [];
    for (let tick = Math.ceil(min / step) * step; tick <= max + step * 1e-9; tick += step) {
        // Snap floating-point drift (0.30000000000000004 -> 0.3)
        ticks.push(Number(tick.toPrecision(12)));
    }
    return ticks;
}

export class LogPlotChart {
    private canvas: HTMLCanvasElement;
    private series: PlotSeries[] = [];
    /** Stride-sampled points per series, in canvas draw order. */
    private sampled: SeriesPoint[][] = [];
    private hidden = new Set<string>();
    private options: ChartOptions = { mode: 'line', xLabel: '', yLabel: '' };
    private bounds: Bounds | null = null;
    private highlight: NearestHit | null = null;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
    }

    public setData(series: PlotSeries[], options: ChartOptions): void {
        this.series = series;
        this.options = options;
        this.highlight = null;
        this.sampled = series.map(s => {
            if (s.points.length <= MAX_DRAW_POINTS) return s.points;
            const stride = Math.ceil(s.points.length / MAX_DRAW_POINTS);
            const sampled = s.points.filter((_, i) => i % stride === 0);
            // Keep the true last point so the line ends where the data does
            if (sampled[sampled.length - 1] !== s.points[s.points.length - 1]) {
                sampled.push(s.points[s.points.length - 1]);
            }
            return sampled;
        });
        this.recomputeBounds();
    }

    public setHidden(hidden: ReadonlySet<string>): void {
        this.hidden = new Set(hidden);
        this.highlight = null;
        this.recomputeBounds();
    }

    public setHighlight(hit: NearestHit | null): void {
        this.highlight = hit;
    }

    private isHidden(index: number): boolean {
        return this.hidden.has(this.series[index]?.label ?? '');
    }

    private recomputeBounds(): void {
        let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        this.sampled.forEach((points, index) => {
            if (this.isHidden(index)) return;
            for (const p of points) {
                if (p.x < xMin) xMin = p.x;
                if (p.x > xMax) xMax = p.x;
                if (p.y < yMin) yMin = p.y;
                if (p.y > yMax) yMax = p.y;
            }
        });
        if (!Number.isFinite(xMin) || !Number.isFinite(yMin)) {
            this.bounds = null;
            return;
        }
        // 4% padding so extreme points do not sit on the frame
        const xPad = (xMax - xMin || Math.abs(xMin) || 1) * 0.04;
        const yPad = (yMax - yMin || Math.abs(yMin) || 1) * 0.04;
        this.bounds = { xMin: xMin - xPad, xMax: xMax + xPad, yMin: yMin - yPad, yMax: yMax + yPad };
    }

    /** CSS-pixel plot area inside the axes. */
    private plotArea(): { left: number; top: number; width: number; height: number } {
        const rect = this.canvas.getBoundingClientRect();
        return {
            left: MARGIN.left,
            top: MARGIN.top,
            width: Math.max(10, rect.width - MARGIN.left - MARGIN.right),
            height: Math.max(10, rect.height - MARGIN.top - MARGIN.bottom),
        };
    }

    private toPx(p: { x: number; y: number }): { px: number; py: number } {
        const area = this.plotArea();
        const b = this.bounds!;
        return {
            px: area.left + ((p.x - b.xMin) / (b.xMax - b.xMin)) * area.width,
            py: area.top + area.height - ((p.y - b.yMin) / (b.yMax - b.yMin)) * area.height,
        };
    }

    /** Resize the backing store to the element's CSS size (DPR-aware) and redraw. */
    public draw(): void {
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(rect.width * dpr);
        const h = Math.round(rect.height * dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }
        const ctx = this.canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, rect.width, rect.height);

        const textColor = themeColor('--text-secondary', '#9aa5b1');
        const mutedColor = themeColor('--text-muted', '#6b7684');
        const gridColor = themeColor('--border', '#3a4552');

        const area = this.plotArea();
        if (!this.bounds) {
            ctx.fillStyle = mutedColor;
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(this.options.emptyMessage ?? 'No plottable data',
                rect.width / 2, rect.height / 2);
            return;
        }

        // Grid + tick labels
        ctx.font = '11px sans-serif';
        ctx.lineWidth = 1;
        for (const tick of niceTicks(this.bounds.xMin, this.bounds.xMax)) {
            const { px } = this.toPx({ x: tick, y: 0 });
            ctx.strokeStyle = gridColor;
            ctx.beginPath();
            ctx.moveTo(px, area.top);
            ctx.lineTo(px, area.top + area.height);
            ctx.stroke();
            ctx.fillStyle = textColor;
            ctx.textAlign = 'center';
            ctx.fillText(formatValue(tick), px, area.top + area.height + 14);
        }
        for (const tick of niceTicks(this.bounds.yMin, this.bounds.yMax, 5)) {
            const { py } = this.toPx({ x: 0, y: tick });
            ctx.strokeStyle = gridColor;
            ctx.beginPath();
            ctx.moveTo(area.left, py);
            ctx.lineTo(area.left + area.width, py);
            ctx.stroke();
            ctx.fillStyle = textColor;
            ctx.textAlign = 'right';
            ctx.fillText(formatValue(tick), area.left - 6, py + 3);
        }

        // Axis labels
        ctx.fillStyle = mutedColor;
        ctx.textAlign = 'center';
        ctx.fillText(this.options.xLabel, area.left + area.width / 2, rect.height - 4);
        ctx.save();
        ctx.translate(10, area.top + area.height / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(this.options.yLabel, 0, 0);
        ctx.restore();

        // Series
        this.sampled.forEach((points, index) => {
            if (this.isHidden(index) || points.length === 0) return;
            const color = seriesColor(index);
            if (this.options.mode === 'line') {
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                points.forEach((p, i) => {
                    const { px, py } = this.toPx(p);
                    if (i === 0) ctx.moveTo(px, py);
                    else ctx.lineTo(px, py);
                });
                ctx.stroke();
            } else {
                ctx.fillStyle = color;
                for (const p of points) {
                    const { px, py } = this.toPx(p);
                    ctx.beginPath();
                    ctx.arc(px, py, 2, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        });

        // Hover highlight ring
        if (this.highlight) {
            const { px, py } = this.toPx(this.highlight.point);
            ctx.strokeStyle = seriesColor(this.highlight.seriesIndex);
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(px, py, 5, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    /**
     * The drawn point nearest to a mouse position (canvas-relative CSS
     * pixels), or null when none is within HOVER_RADIUS_PX.
     */
    public nearest(offsetX: number, offsetY: number): NearestHit | null {
        if (!this.bounds) return null;
        let bestDist = HOVER_RADIUS_PX * HOVER_RADIUS_PX;
        let best: NearestHit | null = null;
        this.sampled.forEach((points, index) => {
            if (this.isHidden(index)) return;
            for (const p of points) {
                const { px, py } = this.toPx(p);
                const dist = (px - offsetX) ** 2 + (py - offsetY) ** 2;
                if (dist < bestDist) {
                    bestDist = dist;
                    best = { seriesIndex: index, series: this.series[index], point: p, px, py };
                }
            }
        });
        return best;
    }
}
