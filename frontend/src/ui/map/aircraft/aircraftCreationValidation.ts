/**
 * Strict numeric parsing for the Create Aircraft modal fields, extracted from
 * AircraftCreationForm so it can be unit-tested without a DOM.
 */

export type NumericFieldResult =
    | { ok: true; value: number }
    | { ok: false; message: string };

/**
 * Parse a numeric form field strictly, with an optional inclusive range.
 *
 * Uses Number() rather than parseFloat so trailing garbage ("10k", "52.3N")
 * is rejected instead of silently truncated to its numeric prefix, and
 * non-finite results are rejected outright. The old parseFloat + range-check
 * code let NaN through (every comparison with NaN is false), so any
 * non-numeric value reaching these fields went out as `CRE ...,NaN,...` —
 * which BlueSky accepts (Python's float("nan") parses) and turns into a
 * broken aircraft.
 */
export function parseNumericField(
    raw: string,
    label: string,
    range?: { min: number; max: number }
): NumericFieldResult {
    const trimmed = raw.trim();
    const value = trimmed === '' ? NaN : Number(trimmed);
    if (!Number.isFinite(value)) {
        return { ok: false, message: `${label} must be a number` };
    }
    if (range && (value < range.min || value > range.max)) {
        return {
            ok: false,
            message: `${label} must be between ${range.min} and ${range.max}`
        };
    }
    return { ok: true, value };
}
