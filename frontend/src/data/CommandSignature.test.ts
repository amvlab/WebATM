/**
 * Characterization tests for the cmddict signature helpers used by the
 * console arg hint and the command palette.
 */
import { describe, it, expect } from 'vitest';
import {
    parseSignature,
    commandFromInput,
    scoreCommand,
    getDisplaySignature,
} from './CommandSignature';

describe('parseSignature', () => {
    it('returns an empty list for an empty signature', () => {
        expect(parseSignature('')).toEqual([]);
    });

    it('parses a simple comma-separated signature', () => {
        const args = parseSignature('callsign,type,lat,lon,hdg,alt,spd');
        expect(args.map(a => a.name)).toEqual([
            'callsign', 'type', 'lat', 'lon', 'hdg', 'alt', 'spd',
        ]);
        expect(args.every(a => !a.optional)).toBe(true);
    });

    it('flags args inside brackets as optional, including inner args', () => {
        const args = parseSignature('n,[type,alt,spd]');
        expect(args.map(a => ({ name: a.name, optional: a.optional }))).toEqual([
            { name: 'n', optional: false },
            { name: 'type', optional: true },
            { name: 'alt', optional: true }, // between the bracket pair
            { name: 'spd', optional: true },
        ]);
    });

    it('keeps the raw token with brackets intact', () => {
        const args = parseSignature('n,[type,alt,spd]');
        expect(args[1].raw).toBe('[type');
        expect(args[3].raw).toBe('spd]');
    });

    it('drops slash variants and lowercases names', () => {
        const args = parseSignature('callsign/ALL/WIND,Shape');
        expect(args[0].name).toBe('callsign');
        expect(args[1].name).toBe('shape');
    });
});

describe('commandFromInput', () => {
    it('extracts and uppercases the leading word', () => {
        expect(commandFromInput('cre KL123')).toBe('CRE');
        expect(commandFromInput('  pan 52,4')).toBe('PAN');
    });

    it('returns null for blank input', () => {
        expect(commandFromInput('')).toBeNull();
        expect(commandFromInput('   ')).toBeNull();
    });
});

describe('scoreCommand', () => {
    it('matches everything with a neutral score on empty query', () => {
        expect(scoreCommand('', 'CRE', 'callsign,type')).toBe(0);
    });

    it('returns null when the query is not a subsequence of name or signature', () => {
        expect(scoreCommand('xyz', 'CRE', 'callsign,type')).toBeNull();
    });

    it('prefers prefix matches over scattered matches', () => {
        const prefix = scoreCommand('cre', 'CRE', '');
        const scattered = scoreCommand('cre', 'CIRCLE', '');
        expect(prefix).not.toBeNull();
        expect(scattered).not.toBeNull();
        expect(prefix!).toBeLessThan(scattered!);
    });

    it('penalizes signature-only matches so name matches sort first', () => {
        const nameMatch = scoreCommand('hdg', 'HDG', '');
        const sigMatch = scoreCommand('hdg', 'TURN', 'callsign,hdg');
        expect(nameMatch).not.toBeNull();
        expect(sigMatch).not.toBeNull();
        expect(sigMatch!).toBeGreaterThanOrEqual(1000);
        expect(nameMatch!).toBeLessThan(sigMatch!);
    });
});

describe('getDisplaySignature', () => {
    it('overrides MCRE with the user-facing signature', () => {
        expect(getDisplaySignature('MCRE', 'n,lat,lon,lat,lon,type,alt,spd'))
            .toBe('n,[type,alt,spd]');
        expect(getDisplaySignature('mcre', 'whatever')).toBe('n,[type,alt,spd]');
    });

    it('falls back to the raw signature for other commands', () => {
        expect(getDisplaySignature('CRE', 'callsign,type')).toBe('callsign,type');
    });
});
