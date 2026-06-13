import { parseSignature, getDisplaySignature } from '../data/CommandSignature';
import type { CommandDict } from '../data/types';

/**
 * Pure helpers for locating the cursor inside console input, extracted
 * from Console so the token/argument math is testable without a DOM.
 * Separators are whitespace and commas (CRE uses the comma form).
 */

export interface InputToken {
    text: string;
    start: number;
    end: number;
}

export interface ArgAtCursor {
    /**
     * 0-based index into the command's parameter list: the command token
     * itself is conceptually at index -1, the first real argument is 0.
     */
    currentArgIndex: number;
    /** Text of the token under the cursor; '' when on a separator run. */
    partialText: string;
    tokenStart: number;
    tokenEnd: number;
    /** All token texts, command first. */
    parts: string[];
}

export interface AcidContext {
    partialAcid: string;
    isCreCommand: boolean;
    acidArgIndex: number;
    /**
     * True when the cursor sits on a token followed by more command
     * content - the user is editing an earlier slot rather than typing at
     * the end. Used to keep the dropdown open even on an exact match.
     */
    isMidInput: boolean;
}

/**
 * Split console input into tokens, keeping the character range each
 * token occupies so callers can locate the token under the cursor
 * without re-scanning the string.
 */
export function tokenizeInput(value: string): InputToken[] {
    const SEP = /[\s,]/;
    const tokens: InputToken[] = [];
    let i = 0;
    while (i < value.length) {
        while (i < value.length && SEP.test(value[i])) i++;
        if (i >= value.length) break;
        const start = i;
        while (i < value.length && !SEP.test(value[i])) i++;
        tokens.push({ text: value.substring(start, i), start, end: i });
    }
    return tokens;
}

/**
 * Find which argument slot the cursor currently sits on, so dropdowns
 * can react to the actual cursor position rather than assuming the
 * cursor is at the end of the input. When the cursor is inside a
 * separator run, partialText is empty and currentArgIndex is the slot
 * that would be filled next.
 */
export function getArgAtCursor(value: string, cursorPos: number): ArgAtCursor {
    const tokens = tokenizeInput(value);
    const parts = tokens.map(t => t.text);

    // Cursor sitting on a token (including at its boundaries) reports that
    // token as the active slot. The <= end check lets a fresh keystroke at
    // end of token still match, matching the previous end-of-input path.
    for (let t = 0; t < tokens.length; t++) {
        const tok = tokens[t];
        if (cursorPos >= tok.start && cursorPos <= tok.end) {
            return {
                currentArgIndex: t - 1,
                partialText: tok.text,
                tokenStart: tok.start,
                tokenEnd: tok.end,
                parts,
            };
        }
    }

    // Cursor is in a separator run (or past all tokens): the active slot
    // is whatever would come next, so count completed tokens before the
    // cursor.
    let tokensBefore = 0;
    for (const tok of tokens) {
        if (tok.end <= cursorPos) tokensBefore++;
        else break;
    }
    return {
        currentArgIndex: tokensBefore - 1,
        partialText: '',
        tokenStart: cursorPos,
        tokenEnd: cursorPos,
        parts,
    };
}

/**
 * Check whether the cursor sits on an aircraft-ID parameter of the
 * current command (per the cmddict signature). Returns the context for
 * the ACID autocomplete dropdown, or null when the slot is not an acid
 * parameter.
 */
export function findAcidContext(
    value: string,
    cursorPos: number,
    cmddict: CommandDict | null
): AcidContext | null {
    const { currentArgIndex, partialText, tokenEnd, parts } = getArgAtCursor(value, cursorPos);
    if (parts.length < 1) return null;

    const isMidInput = value.substring(tokenEnd).trim().length > 0;

    const command = parts[0].toUpperCase();
    const isCreCommand = command === 'CRE' || command === 'MCRE';

    if (!cmddict || !cmddict[command]) return null;

    const rawParamString = cmddict[command];
    if (!rawParamString) return null;

    // Use the user-facing signature so MCRE (where CommandHandler
    // injects lat/lon) lines up the user's typed args with the param
    // positions we're inspecting.
    const paramString = getDisplaySignature(command, rawParamString);
    const params = parseSignature(paramString).map(arg => arg.name);

    // Find which parameter position we're at
    if (currentArgIndex < 0 || currentArgIndex >= params.length) return null;

    const currentParam = params[currentArgIndex];

    // Check if this parameter is an acid-type parameter
    const acidParamNames = ['acid', 'acidx', 'id', 'idx'];
    if (!acidParamNames.includes(currentParam)) return null;

    return { partialAcid: partialText, isCreCommand, acidArgIndex: currentArgIndex, isMidInput };
}
