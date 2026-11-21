// @vitest-environment happy-dom
/**
 * LogPlotChart hit-testing: nearest-point lookup for the hover readout, and
 * the guarantee that a lookup resolves layout once, not once per point
 * (a per-point getBoundingClientRect made hover janky on large logs).
 * Drawing itself is not asserted (happy-dom has no canvas 2D context).
 */
import { describe, it, expect, vi } from 'vitest';
import { LogPlotChart } from './logPlotChart';
import type { PlotSeries } from './logPlotData';

const RECT = {
    width: 400, height: 300, x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 300,
    toJSON: () => ({}),
} as DOMRect;

const SERIES: PlotSeries[] = [
    { label: 'KL001', points: [{ x: 0, y: 0, row: 0 }, { x: 10, y: 10, row: 2 }] },
    { label: 'KL002', points: [{ x: 0, y: 10, row: 1 }, { x: 10, y: 0, row: 3 }] },
];

function makeChart(): { chart: LogPlotChart; rectSpy: ReturnType<typeof vi.spyOn> } {
    const canvas = document.createElement('canvas');
    const rectSpy = vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(RECT);
    const chart = new LogPlotChart(canvas);
    chart.setData(SERIES, { mode: 'line', xLabel: 'x', yLabel: 'y' });
    return { chart, rectSpy };
}

/** Pixel position of a data point, from the chart's own margins and 4% padding. */
function expectedPx(x: number, y: number): { px: number; py: number } {
    const area = { left: 58, top: 12, width: 400 - 58 - 16, height: 300 - 12 - 34 };
    const min = -0.4, max = 10.4; // data 0..10 on both axes, 4% padding
    return {
        px: area.left + ((x - min) / (max - min)) * area.width,
        py: area.top + area.height - ((y - min) / (max - min)) * area.height,
    };
}

describe('LogPlotChart.nearest', () => {
    it('returns the point nearest the cursor with its pixel position', () => {
        const { chart } = makeChart();
        const { px, py } = expectedPx(0, 0);
        const hit = chart.nearest(px + 3, py - 3);
        expect(hit).not.toBeNull();
        expect(hit!.series.label).toBe('KL001');
        expect(hit!.point).toEqual({ x: 0, y: 0, row: 0 });
        expect(hit!.px).toBeCloseTo(px, 5);
        expect(hit!.py).toBeCloseTo(py, 5);
    });

    it('returns null when nothing is within the hover radius', () => {
        const { chart } = makeChart();
        expect(chart.nearest(200, 120)).toBeNull();
    });

    it('ignores hidden series', () => {
        const { chart } = makeChart();
        const { px, py } = expectedPx(0, 0);
        expect(chart.nearest(px, py)!.series.label).toBe('KL001');
        chart.setHidden(new Set(['KL001']));
        expect(chart.nearest(px, py)).toBeNull();
    });

    it('resolves layout once per lookup, not once per point', () => {
        const { chart, rectSpy } = makeChart();
        rectSpy.mockClear();
        chart.nearest(100, 100);
        expect(rectSpy).toHaveBeenCalledTimes(1);
    });
});
