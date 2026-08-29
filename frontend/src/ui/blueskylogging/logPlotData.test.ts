/**
 * Log Plot data layer: parsing BlueSky CRELOG log text into typed columns,
 * splitting rows into per-aircraft series, and column statistics.
 */
import { describe, it, expect } from 'vitest';
import {
    buildSeries,
    columnStats,
    formatValue,
    MAX_SERIES,
    parseLogText,
    plotabilityError,
} from './logPlotData';
import { niceTicks } from './logPlotChart';

/** A realistic CRELOG output snippet: comments, then simt,id,lat,lon,alt rows. */
const SAMPLE = `# My experiment log
# 20 aircraft over Amsterdam
1.00000000,KL001,52.30000000,4.76000000,3048.00000000
1.00000000,KL002,52.40000000,4.80000000,3352.80000000
2.00000000,KL001,52.30100000,4.76100000,3050.00000000
2.00000000,KL002,52.40100000,4.80100000,3360.00000000
`;

describe('parseLogText', () => {
    it('parses rows, comments and column types from a CRELOG log', () => {
        const log = parseLogText(SAMPLE);
        expect(log.rows).toHaveLength(4);
        expect(log.comments).toEqual(['My experiment log', '20 aircraft over Amsterdam']);
        expect(log.columns.map(c => c.numeric)).toEqual([true, false, true, true, true]);
        expect(log.skipped).toBe(0);
        // Numeric cells become numbers; the id column stays text
        expect(log.rows[0][0]).toBe(1);
        expect(log.rows[0][1]).toBe('KL001');
        expect(log.rows[0][4]).toBeCloseTo(3048);
    });

    it('names the first numeric column simt and the rest generically', () => {
        const log = parseLogText(SAMPLE);
        expect(log.columns.map(c => c.name)).toEqual(['simt', 'col2', 'col3', 'col4', 'col5']);
    });

    it('takes column names from a comment header with a matching field count', () => {
        const log = parseLogText('# simt, id, lat, lon, alt\n' + SAMPLE);
        expect(log.columns.map(c => c.name)).toEqual(['simt', 'id', 'lat', 'lon', 'alt']);
    });

    it('uses the first non-numeric column as the group column', () => {
        expect(parseLogText(SAMPLE).groupColumn).toBe(1);
        expect(parseLogText('1,2\n3,4\n').groupColumn).toBeNull();
    });

    it('drops rows whose field count differs and tallies them', () => {
        const log = parseLogText(SAMPLE + 'garbage line without commas\n5.0,KL001\n');
        expect(log.rows).toHaveLength(4);
        expect(log.skipped).toBe(2);
    });

    it('handles empty and comment-only input', () => {
        expect(parseLogText('').rows).toHaveLength(0);
        const commentOnly = parseLogText('# just a header\n');
        expect(commentOnly.rows).toHaveLength(0);
        expect(commentOnly.comments).toEqual(['just a header']);
    });

    it('marks a column numeric despite a few bad cells (>=90% parseable)', () => {
        const lines = Array.from({ length: 19 }, (_, i) => `${i},${i * 2}`);
        lines.push('19,oops');
        const log = parseLogText(lines.join('\n'));
        expect(log.columns[1].numeric).toBe(true);
        expect(log.rows[19][1]).toBeNaN();
    });
});

describe('buildSeries', () => {
    it('splits rows into one series per aircraft in first-appearance order', () => {
        const log = parseLogText(SAMPLE);
        const series = buildSeries(log, 0, 4); // simt vs alt
        expect(series.map(s => s.label)).toEqual(['KL001', 'KL002']);
        expect(series[0].points).toEqual([
            { x: 1, y: 3048, row: 0 },
            { x: 2, y: 3050, row: 2 },
        ]);
    });

    it('returns a single series when the log has no group column', () => {
        const log = parseLogText('1,10\n2,20\n3,30\n');
        const series = buildSeries(log, 0, 1);
        expect(series).toHaveLength(1);
        expect(series[0].label).toBe('data');
        expect(series[0].points).toHaveLength(3);
    });

    it('skips rows with non-finite coordinates', () => {
        // One bad cell in 20 keeps the column numeric (>=90% parseable) but
        // that row must not produce a point.
        const lines = Array.from({ length: 20 }, (_, i) =>
            `${i},A,${i === 7 ? 'notanumber' : i * 2}`);
        const log = parseLogText(lines.join('\n'));
        expect(log.columns[2].numeric).toBe(true);
        const series = buildSeries(log, 0, 2);
        expect(series).toHaveLength(1);
        expect(series[0].points).toHaveLength(19);
        expect(series[0].points.some(p => p.x === 7)).toBe(false);
    });

    it('folds groups beyond MAX_SERIES into an overflow series', () => {
        const lines = Array.from({ length: MAX_SERIES + 5 }, (_, i) => `1,AC${i},${i}`);
        const log = parseLogText(lines.join('\n'));
        const series = buildSeries(log, 0, 2);
        expect(series).toHaveLength(MAX_SERIES + 1);
        expect(series[series.length - 1].label).toBe('(other)');
        expect(series[series.length - 1].points).toHaveLength(5);
    });
});

describe('plotabilityError', () => {
    // BlueSky's CONFLOG (bluesky/plugins/area.py): an event log whose values
    // are passed as extra log() arguments, so datalog's column comment line
    // ("# simt") names fewer fields than the rows carry.
    const CONFLOG = [
        '# #######################################################',
        '# CONF LOG',
        '# Conflict Statistics',
        '# #######################################################',
        '#',
        '# Parameters [Units]:',
        '# Simulation time [s], Total number of conflicts in exp area [-]',
        '# simt',
        '123.00000000,1',
        '245.50000000,3',
    ].join('\n');

    it('accepts a periodic CRELOG log', () => {
        expect(plotabilityError(parseLogText(SAMPLE))).toBeNull();
        expect(plotabilityError(parseLogText('# simt, id, lat, lon, alt\n' + SAMPLE))).toBeNull();
    });

    it('rejects CONFLOG-style event logs via the column-line mismatch', () => {
        expect(plotabilityError(parseLogText(CONFLOG))).toMatch(/2 fields but its header names 1/);
    });

    it('rejects an FLSTLOG-style event log (many fields, header names only simt)', () => {
        const flst = [
            '# FLST LOG',
            '# Deletion Time [s], Call sign [-], Spawn Time [s], Flight time [s]',
            '# simt',
            '900.00000000,KL001,10.00000000,890.00000000',
        ].join('\n');
        expect(plotabilityError(parseLogText(flst))).toMatch(/event log/);
    });

    it('rejects files without data, without a numeric time column, or without data columns', () => {
        expect(plotabilityError(parseLogText('# just comments\n'))).toMatch(/no data rows/);
        expect(plotabilityError(parseLogText('a,1\nb,2\nc,3\n'))).toMatch(/first column/);
        expect(plotabilityError(parseLogText('1,a\n2,b\n3,c\n'))).toMatch(/no numeric data column/);
    });

    it('rejects files where most rows do not fit one table', () => {
        const messy = '1,2\n2,3\nprose\na,b,c\nd,e,f,g\n';
        expect(plotabilityError(parseLogText(messy))).toMatch(/consistent table/);
    });
});

describe('columnStats', () => {
    it('computes count/min/mean/max of a numeric column', () => {
        const log = parseLogText(SAMPLE);
        const stats = columnStats(log, 4)!; // alt
        expect(stats.count).toBe(4);
        expect(stats.min).toBeCloseTo(3048);
        expect(stats.max).toBeCloseTo(3360);
        expect(stats.mean).toBeCloseTo((3048 + 3352.8 + 3050 + 3360) / 4);
    });

    it('returns null for non-numeric or out-of-range columns', () => {
        const log = parseLogText(SAMPLE);
        expect(columnStats(log, 1)).toBeNull(); // id column
        expect(columnStats(log, 99)).toBeNull();
    });
});

describe('formatValue', () => {
    it('formats magnitudes readably', () => {
        expect(formatValue(52)).toBe('52');
        expect(formatValue(52.30125)).toBe('52.301');
        expect(formatValue(3048.5)).toBe('3048.5');
        expect(formatValue(0.00001234)).toBe('1.234e-5');
        expect(formatValue(12345678)).toBe('1.235e+7');
        expect(formatValue(NaN)).toBe('-');
    });
});

describe('niceTicks', () => {
    it('produces round ticks spanning the range', () => {
        const ticks = niceTicks(0, 10, 5);
        expect(ticks[0]).toBeGreaterThanOrEqual(0);
        expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(10 + 1e-9);
        expect(ticks).toContain(0);
        expect(ticks).toContain(10);
    });

    it('handles a degenerate zero-width range', () => {
        const ticks = niceTicks(5, 5);
        expect(ticks.length).toBeGreaterThan(0);
    });

    it('returns [] for non-finite input', () => {
        expect(niceTicks(NaN, 10)).toEqual([]);
    });
});
