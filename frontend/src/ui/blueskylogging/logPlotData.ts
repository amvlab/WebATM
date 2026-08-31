/**
 * Pure parsing/statistics helpers for the Log Plot modal: turns the text of a
 * BlueSky CRELOG data log (comma-separated rows, '#' comment header, simt as
 * the first column; one row per aircraft per interval) into typed columns and
 * plottable series. Kept free of DOM so it is directly unit-testable.
 */

/** One column of a parsed log file. */
export interface LogColumn {
    name: string;
    /** True when (almost) every non-empty cell parses as a finite number. */
    numeric: boolean;
}

/** A parsed data log: typed columns plus row-major data. */
export interface ParsedLog {
    columns: LogColumn[];
    /** Row-major cells: numbers in numeric columns (NaN when unparseable), strings elsewhere. */
    rows: (string | number)[][];
    /** '#' comment lines from the file head, without the marker. */
    comments: string[];
    /**
     * Index of the first non-numeric column (typically traf.id callsigns),
     * used to split rows into one series per aircraft; null when every
     * column is numeric.
     */
    groupColumn: number | null;
    /** Rows dropped because their field count did not match the table. */
    skipped: number;
}

/** Fraction of non-empty cells that must parse as numbers for a numeric column. */
const NUMERIC_THRESHOLD = 0.9;

function toNumber(cell: string): number {
    if (cell === '') return NaN;
    const value = Number(cell);
    return Number.isFinite(value) ? value : NaN;
}

/**
 * Parse the text of a data log file. Lines starting with '#' are collected
 * as comments; the remaining lines are split on commas. The column count is
 * the most common field count among data lines (rows with a different count
 * are dropped and tallied in `skipped`). Column names come from the last
 * comment line that splits into exactly that many comma-separated tokens
 * (a user-provided "simt, id, lat, ..." header); otherwise the first column
 * is called `simt` when numeric (BlueSky's periodic logger always writes
 * simulation time first) and the rest `col2`, `col3`, ...
 */
export function parseLogText(text: string): ParsedLog {
    const comments: string[] = [];
    const rawRows: string[][] = [];

    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('#')) {
            comments.push(line.replace(/^#\s?/, ''));
            continue;
        }
        rawRows.push(line.split(',').map(cell => cell.trim()));
    }

    // Column count = the most common field count among data rows
    const countTally = new Map<number, number>();
    for (const row of rawRows) {
        countTally.set(row.length, (countTally.get(row.length) ?? 0) + 1);
    }
    let columnCount = 0;
    let best = 0;
    countTally.forEach((tally, count) => {
        if (tally > best) {
            best = tally;
            columnCount = count;
        }
    });

    const wellFormed = rawRows.filter(row => row.length === columnCount);
    const skipped = rawRows.length - wellFormed.length;

    // Column typing: numeric when >= NUMERIC_THRESHOLD of non-empty cells parse
    const numeric: boolean[] = [];
    for (let c = 0; c < columnCount; c++) {
        let nonEmpty = 0;
        let parseable = 0;
        for (const row of wellFormed) {
            if (row[c] === '') continue;
            nonEmpty++;
            if (Number.isFinite(Number(row[c]))) parseable++;
        }
        numeric.push(nonEmpty > 0 && parseable >= nonEmpty * NUMERIC_THRESHOLD);
    }

    const names = headerNames(comments, columnCount) ??
        Array.from({ length: columnCount }, (_, c) =>
            c === 0 && numeric[0] ? 'simt' : `col${c + 1}`);

    const columns: LogColumn[] = names.map((name, c) => ({ name, numeric: numeric[c] }));
    const rows = wellFormed.map(row =>
        row.map((cell, c) => (numeric[c] ? toNumber(cell) : cell)));

    const groupColumn = numeric.indexOf(false);

    return {
        columns,
        rows,
        comments,
        groupColumn: groupColumn === -1 ? null : groupColumn,
        skipped,
    };
}

/**
 * Column names from the file's comment header: the last comment line that
 * splits into exactly `columnCount` non-empty comma-separated tokens, or
 * null when no comment line looks like a header.
 */
function headerNames(comments: readonly string[], columnCount: number): string[] | null {
    if (columnCount < 2) return null;
    for (let i = comments.length - 1; i >= 0; i--) {
        const tokens = comments[i].split(',').map(t => t.trim());
        if (tokens.length === columnCount && tokens.every(t => t.length > 0)) {
            return tokens;
        }
    }
    return null;
}

/**
 * Returns a human-readable reason the quick-look plot cannot honestly draw
 * this log, or null when it can (a periodic data log with simulation time
 * first). Event loggers such as CONFLOG/FLSTLOG pass their values as extra
 * `log()` arguments, so their "# simt" column line names fewer fields than
 * the rows carry — that mismatch marks a format this viewer cannot plot.
 */
export function plotabilityError(log: ParsedLog): string | null {
    if (log.rows.length === 0) {
        return 'the file has no data rows';
    }
    if (log.skipped > log.rows.length) {
        return 'most of its rows do not fit one consistent table';
    }
    if (!log.columns[0]?.numeric) {
        return 'its first column is not simulation time';
    }
    if (log.columns.filter(c => c.numeric).length < 2) {
        return 'it has no numeric data column to plot against time';
    }
    const lastComment = log.comments[log.comments.length - 1]?.trim() ?? '';
    if (/^simt\s*(,|$)/i.test(lastComment)) {
        const named = lastComment.split(',').length;
        if (named !== log.columns.length) {
            return `its rows carry ${log.columns.length} fields but its header names ${named} ` +
                '(an event log such as CONFLOG, not a periodic data log)';
        }
    }
    return null;
}

/** One plottable point; `row` is the source row index (for readouts). */
export interface SeriesPoint {
    x: number;
    y: number;
    row: number;
}

/** A named line/point series (one per aircraft when a group column exists). */
export interface PlotSeries {
    label: string;
    points: SeriesPoint[];
}

/** More groups than this are folded into the last "…" series. */
export const MAX_SERIES = 40;

/**
 * Build plot series from two numeric columns, split into one series per
 * distinct value of the log's group column (typically the aircraft id) in
 * first-appearance order. Rows where either coordinate is not finite are
 * skipped. When the log has no group column, one series named 'data' holds
 * every row. At most MAX_SERIES groups are kept; the overflow goes into a
 * final series so the point count stays honest.
 */
export function buildSeries(log: ParsedLog, xCol: number, yCol: number): PlotSeries[] {
    const series = new Map<string, PlotSeries>();
    const overflowLabel = '(other)';

    log.rows.forEach((row, rowIndex) => {
        const x = row[xCol];
        const y = row[yCol];
        if (typeof x !== 'number' || typeof y !== 'number' ||
            !Number.isFinite(x) || !Number.isFinite(y)) return;

        let label = log.groupColumn === null ? 'data' : String(row[log.groupColumn]);
        if (!series.has(label) && series.size >= MAX_SERIES) {
            label = overflowLabel;
        }
        let entry = series.get(label);
        if (!entry) {
            entry = { label, points: [] };
            series.set(label, entry);
        }
        entry.points.push({ x, y, row: rowIndex });
    });

    return Array.from(series.values());
}

/** Summary statistics of one numeric column (NaN cells excluded). */
export interface ColumnStats {
    count: number;
    min: number;
    max: number;
    mean: number;
}

/** Stats for a numeric column, or null for non-numeric/empty columns. */
export function columnStats(log: ParsedLog, col: number): ColumnStats | null {
    if (!log.columns[col]?.numeric) return null;
    let count = 0;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const row of log.rows) {
        const value = row[col];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        count++;
        sum += value;
        if (value < min) min = value;
        if (value > max) max = value;
    }
    if (count === 0) return null;
    return { count, min, max, mean: sum / count };
}

/** Compact number formatting for axis ticks, readouts and stats tables. */
export function formatValue(value: number): string {
    if (!Number.isFinite(value)) return '-';
    const abs = Math.abs(value);
    if (abs !== 0 && (abs >= 1e6 || abs < 1e-3)) return value.toExponential(3);
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(abs >= 100 ? 1 : abs >= 1 ? 3 : 5);
}
