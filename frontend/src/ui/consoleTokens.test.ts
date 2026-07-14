/**
 * Tests for the console input token/argument helpers used by the ACID
 * and aircraft-type autocomplete dropdowns.
 */
import { describe, it, expect } from 'vitest';
import {
    tokenizeInput,
    getArgAtCursor,
    argStartIndex,
    findAcidContext,
} from './consoleTokens';

describe('tokenizeInput', () => {
    it('splits on whitespace and commas, keeping character ranges', () => {
        expect(tokenizeInput('CRE KL123,A320')).toEqual([
            { text: 'CRE', start: 0, end: 3 },
            { text: 'KL123', start: 4, end: 9 },
            { text: 'A320', start: 10, end: 14 },
        ]);
    });

    it('collapses separator runs and ignores leading/trailing separators', () => {
        expect(tokenizeInput('  HDG   KL123 , 90 ').map(t => t.text))
            .toEqual(['HDG', 'KL123', '90']);
    });

    it('returns no tokens for blank input', () => {
        expect(tokenizeInput('')).toEqual([]);
        expect(tokenizeInput('  , ')).toEqual([]);
    });
});

describe('getArgAtCursor', () => {
    const input = 'CRE KL123 A320';

    it('reports the command token as index -1', () => {
        const at = getArgAtCursor(input, 2);
        expect(at.currentArgIndex).toBe(-1);
        expect(at.partialText).toBe('CRE');
    });

    it('reports the token under the cursor, including at its end boundary', () => {
        const at = getArgAtCursor(input, 9); // end of KL123
        expect(at.currentArgIndex).toBe(0);
        expect(at.partialText).toBe('KL123');
        expect(at.tokenStart).toBe(4);
        expect(at.tokenEnd).toBe(9);
    });

    it('reports an empty next slot when the cursor is in a separator run', () => {
        const at = getArgAtCursor('CRE KL123 ', 10);
        expect(at.currentArgIndex).toBe(1);
        expect(at.partialText).toBe('');
        expect(at.tokenStart).toBe(10);
    });

    it('lists all token texts with the command first', () => {
        expect(getArgAtCursor(input, 12).parts).toEqual(['CRE', 'KL123', 'A320']);
    });

    // Ported from the retired CommandSignature.currentArgIndex, which the
    // arg hint used before it switched to this shared implementation.
    it('advances on separators (space and comma)', () => {
        expect(getArgAtCursor('CRE KL123 ', 10).currentArgIndex).toBe(1);
        expect(getArgAtCursor('CRE KL123,A320', 14).currentArgIndex).toBe(1);
        expect(getArgAtCursor('CRE KL123,A320,', 15).currentArgIndex).toBe(2);
    });

    it('ignores leading whitespace before the command', () => {
        expect(getArgAtCursor(' CRE KL123', 10).currentArgIndex).toBe(0);
        expect(getArgAtCursor('  CRE KL123,A320', 16).currentArgIndex).toBe(1);
    });

    it('returns -1 for empty or whitespace-only input', () => {
        expect(getArgAtCursor('', 0).currentArgIndex).toBe(-1);
        expect(getArgAtCursor('   ', 3).currentArgIndex).toBe(-1);
    });
});

describe('argStartIndex', () => {
    it('returns the character index where an argument begins', () => {
        expect(argStartIndex('CRE KL123 A320', 0)).toBe(4);
        expect(argStartIndex('CRE KL123 A320', 1)).toBe(10);
        expect(argStartIndex('CRE KL123,A320', 1)).toBe(10);
    });

    it('returns the input length for a slot not yet typed', () => {
        expect(argStartIndex('CRE KL123', 1)).toBe(9);
        expect(argStartIndex('CRE KL123 ', 1)).toBe(10);
    });

    it('is not confused by leading whitespace before the command', () => {
        // Regression: the old separator-run walker counted the leading
        // whitespace as the run after the command, so a map click replaced
        // the command token itself instead of the target argument.
        expect(argStartIndex(' CRE KL123', 0)).toBe(5);
        expect(argStartIndex('  CRE KL123 A320', 1)).toBe(12);
    });
});

describe('findAcidContext', () => {
    const cmddict = {
        CRE: 'acid,type,lat,lon,hdg,alt,spd',
        HDG: 'acid,hdg',
        PAN: 'latlon',
        MCRE: 'n,lat,lon,lat,lon,type,alt,spd',
    };

    it('matches when the cursor is on an acid parameter', () => {
        const ctx = findAcidContext('HDG KL1', 7, cmddict);
        expect(ctx).toEqual({
            partialAcid: 'KL1',
            isCreCommand: false,
            acidArgIndex: 0,
            isMidInput: false,
        });
    });

    it('flags CRE/MCRE commands and mid-input editing', () => {
        const ctx = findAcidContext('CRE KL123 A320', 6, cmddict);
        expect(ctx?.isCreCommand).toBe(true);
        expect(ctx?.isMidInput).toBe(true);
        expect(ctx?.partialAcid).toBe('KL123');
    });

    it('returns null for non-acid slots, unknown commands, and missing cmddict', () => {
        expect(findAcidContext('HDG KL123 90', 11, cmddict)).toBeNull(); // hdg slot
        expect(findAcidContext('PAN 52', 6, cmddict)).toBeNull();
        expect(findAcidContext('NOPE x', 6, cmddict)).toBeNull();
        expect(findAcidContext('HDG KL1', 7, null)).toBeNull();
    });

    it('returns null while still typing the command token', () => {
        expect(findAcidContext('HD', 2, cmddict)).toBeNull();
    });

    it('uses the display signature for MCRE (no acid slot offset by lat/lon)', () => {
        // MCRE's user-facing signature is 'n,[type,alt,spd]' - none of
        // those are acid parameters, so no acid context anywhere.
        expect(findAcidContext('MCRE 5 A320', 7, cmddict)).toBeNull();
    });
});
