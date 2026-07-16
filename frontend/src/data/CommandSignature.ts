/**
 * Pure helpers for working with cmddict argument signatures.
 *
 * cmddict ships from the backend as a flat `{ COMMAND: "arg1,arg2,[arg3]" }`
 * map with no help text. These DOM-free helpers parse a signature string and
 * score commands for the searchable palette, so the inline hint, panels, and
 * modal palette can all reuse them. (Cursor/argument location helpers live in
 * ui/consoleTokens.ts.)
 */

import type { CommandDict } from './types';

export interface SignatureArg {
    /** Normalized arg name (lowercased, brackets/slash-variants stripped). */
    name: string;
    /** Original token as it appeared in the signature, brackets included. */
    raw: string;
    /**
     * User-facing label: the raw token with the optional-arg brackets
     * stripped but slash variants and casing kept, so hints can show
     * `lat/acid/LEFT/...` instead of collapsing it to `lat`.
     */
    label: string;
    /** True when the arg is wrapped in `[...]` brackets in the signature. */
    optional: boolean;
}

/**
 * Commands whose user-facing signature differs from the raw cmddict one
 * because `CommandHandler` rewrites the input before sending it.
 *
 * Only MCRE qualifies today: the user types `MCRE n,[type,alt,spd]` and
 * `CommandHandler.handleMcreCommand` injects the bounding-box coordinates,
 * so surfacing the wire signature would mislead users into typing lat/lon.
 */
const DISPLAY_SIGNATURE_OVERRIDES: Record<string, string> = {
    MCRE: 'n,[type,alt,spd]',
};

/**
 * Client-side commands handled by `CommandHandler` (never sent to the
 * server), with user-facing signatures. The server's cmddict knows nothing
 * about these, so the command palette merges this map into its list.
 *
 * Keep in sync with `CommandHandler`'s LOCAL_COMMANDS/PREPROCESSED_COMMANDS
 * (a CommandHandler test asserts every handled command has an entry here).
 */
export const LOCAL_COMMAND_SIGNATURES: Record<string, string> = {
    PAN: 'lat/acid/wpt/apt/LEFT/RIGHT/UP/DOWN,[lon]',
    ZOOM: 'level/IN/OUT',
    ZOOMIN: '',
    ZOOMOUT: '',
    SWRAD: 'APT/WPT/LABEL/SYM/TRAIL/POLY,[level]',
    SHOWTRAF: '[ON/OFF]',
    SHOWPZ: '[ON/OFF]',
    SHOWPOLY: '[ON/OFF]',
    SHOWAPT: '[ON/OFF]',
    SHOWWPT: '[ON/OFF]',
    LABEL: '[0/1/2/ON/OFF]',
    FILTERALT: '[ON/OFF,bottom,top]',
    QUIT: '',
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
 * Merge the server's cmddict with WebATM's client-side command signatures.
 *
 * The local signatures win on name collisions: `CommandHandler` intercepts
 * those commands before they ever reach the server, so the local signature
 * describes what actually happens. This is the dictionary every user-facing
 * lookup (arg hint, ghost suggestion, autocomplete, palette) should use, so
 * client-side commands like PAN resolve even before/without a server cmddict.
 */
export function getEffectiveDict(cmddict: CommandDict | null): CommandDict {
    return { ...(cmddict ?? {}), ...LOCAL_COMMAND_SIGNATURES };
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
        const label = trimmedRaw.replace(/^\[+/, '').replace(/\]+$/, '').trim();
        let name = label.toLowerCase();
        const slashIdx = name.indexOf('/');
        if (slashIdx >= 0) name = name.substring(0, slashIdx);
        return { name: name.trim(), raw: trimmedRaw, label, optional };
    });
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
