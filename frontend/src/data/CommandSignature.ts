/**
 * Pure helpers for working with cmddict argument signatures.
 *
 * cmddict ships from the backend (node_runner.py) as a flat
 * `{ COMMAND: "arg1,arg2,[arg3]" }` map - no help text. These helpers parse a
 * signature string, locate the cursor's current argument, and score commands
 * for the searchable palette. All functions are DOM-free so they can be reused
 * by the inline hint, the left panel, the modal palette, and (eventually) the
 * client-side validator from TODO #2.
 */

export interface SignatureArg {
    /** Normalized arg name (lowercased, brackets/slash-variants stripped). */
    name: string;
    /** Original token as it appeared in the signature, brackets included. */
    raw: string;
    /** True when the arg is wrapped in `[...]` brackets in the signature. */
    optional: boolean;
}

/**
 * Map of commands whose user-facing signature differs from the raw cmddict
 * signature because `CommandHandler` rewrites the input before sending it
 * to the backend.
 *
 * Today only MCRE qualifies: the user types `MCRE n[,type[,alt[,spd]]]` and
 * `CommandHandler.handleMcreCommand` injects the four bounding-box
 * coordinates (south, west, north, east) before the optional tail. Surfacing
 * the wire signature in the hint would mislead users into typing lat/lon
 * themselves.
 */
const DISPLAY_SIGNATURE_OVERRIDES: Record<string, string> = {
    MCRE: 'n,[type,alt,spd]',
};

/**
 * Return the signature to render in user-facing surfaces (arg hint, palette
 * row). Falls back to the raw cmddict signature for everything that doesn't
 * have an override.
 */
export function getDisplaySignature(name: string, rawSig: string): string {
    return DISPLAY_SIGNATURE_OVERRIDES[name.toUpperCase()] ?? rawSig;
}

/**
 * Parse a cmddict signature into normalized argument descriptors.
 *
 * Signatures look like:
 *   "callsign,type,lat,lon,hdg,alt,spd"
 *   "n,[lat,lon,lat,lon,type,alt,spd]"
 *   "callsign/ALL/WIND/shape"
 *
 * We strip the optional-arg brackets, drop anything after a "/" variant
 * separator, and lowercase the result so name matching is consistent.
 */
export function parseSignature(sig: string): SignatureArg[] {
    if (!sig) return [];
    // Track bracket depth across the comma split so that args sitting
    // *between* the open/close pair (e.g. `alt` in `[type,alt,spd]`) are
    // flagged as optional, not just the tokens that personally carry a
    // bracket character.
    let depth = 0;
    return sig.split(',').map(raw => {
        const trimmedRaw = raw.trim();
        const opens = (trimmedRaw.match(/\[/g) ?? []).length;
        const closes = (trimmedRaw.match(/\]/g) ?? []).length;
        const optional = depth > 0 || opens > 0 || closes > 0;
        depth += opens - closes;
        let name = trimmedRaw.toLowerCase();
        name = name.replace(/^\[+/, '').replace(/\]+$/, '');
        const slashIdx = name.indexOf('/');
        if (slashIdx >= 0) name = name.substring(0, slashIdx);
        return { name: name.trim(), raw: trimmedRaw, optional };
    });
}

/**
 * Determine which argument index the cursor sits on for the given input.
 *
 * The first whitespace-delimited token is the command itself. Subsequent
 * tokens, separated by spaces or commas (CRE uses commas), are arguments.
 * Returns -1 when the cursor is still on the command token, or when input
 * is empty / cursor is out of range.
 *
 * A cursor on a separator (e.g. just after a comma or trailing space) is
 * treated as "on the next arg slot" so the inline hint advances as soon as
 * the user types the separator.
 */
export function currentArgIndex(input: string, cursor: number): number {
    if (!input) return -1;
    const clamped = Math.max(0, Math.min(cursor, input.length));
    const upTo = input.substring(0, clamped);

    // Find the end of the command token (first whitespace).
    const cmdEnd = upTo.search(/\s/);
    if (cmdEnd === -1) return -1; // still typing the command

    // Count separator runs after the command token. Each run advances the
    // arg index by one. Treat both whitespace and comma as separators so
    // CRE's comma-separated form behaves the same as space-separated forms.
    const after = upTo.substring(cmdEnd);
    let argIndex = -1;
    let inSep = true; // we start right after the command, on a separator run
    for (let i = 0; i < after.length; i++) {
        if (/[\s,]/.test(after[i])) {
            inSep = true;
        } else if (inSep) {
            // First non-separator after a run begins a new argument.
            argIndex++;
            inSep = false;
        }
    }
    // A cursor on a trailing separator is poised to type the next arg.
    if (inSep && /[\s,]$/.test(upTo)) {
        argIndex++;
    }
    return argIndex;
}

/**
 * Extract the command name (uppercased) from raw input. Returns null when
 * the input has no leading word.
 */
export function commandFromInput(input: string): string | null {
    const m = input.match(/^\s*(\S+)/);
    return m ? m[1].toUpperCase() : null;
}

/**
 * Subsequence-based fuzzy score. Returns a non-negative number where lower
 * is better, or null when the query characters can't be matched in order.
 *
 * Scoring favors:
 *   - matches that start at the beginning of the candidate
 *   - contiguous matches (consecutive query chars hit consecutive haystack
 *     chars) over scattered ones
 *
 * Case-insensitive. The signature is searched in addition to the name so a
 * query like "head" matches `HDG` (signature contains "hdg").
 */
export function scoreCommand(
    query: string,
    name: string,
    sig: string
): number | null {
    if (!query) return 0; // empty query matches everything with neutral score
    const q = query.toLowerCase();

    const nameScore = subsequenceScore(q, name.toLowerCase());
    if (nameScore !== null) {
        // Name matches always beat signature-only matches.
        return nameScore;
    }
    const sigScore = subsequenceScore(q, sig.toLowerCase());
    if (sigScore !== null) {
        // Penalize signature matches so name matches sort first.
        return sigScore + 1000;
    }
    return null;
}

function subsequenceScore(query: string, haystack: string): number | null {
    let qi = 0;
    let score = 0;
    let lastMatch = -2;
    let firstMatch = -1;
    for (let hi = 0; hi < haystack.length && qi < query.length; hi++) {
        if (haystack[hi] === query[qi]) {
            if (firstMatch === -1) firstMatch = hi;
            // Gap penalty: contiguous matches add nothing, every skipped
            // haystack char between matches adds 1.
            if (lastMatch >= 0) {
                score += hi - lastMatch - 1;
            }
            lastMatch = hi;
            qi++;
        }
    }
    if (qi < query.length) return null;
    // Reward matches that start at position 0.
    score += firstMatch;
    return score;
}
