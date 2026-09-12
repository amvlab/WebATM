import { describe, it, expect } from 'vitest';
import { parseNumericField } from './aircraftCreationValidation';

describe('parseNumericField', () => {
    it('parses plain and fractional numbers, ignoring whitespace', () => {
        expect(parseNumericField('52', 'Latitude')).toEqual({ ok: true, value: 52 });
        expect(parseNumericField(' 4.75 ', 'Longitude')).toEqual({ ok: true, value: 4.75 });
        expect(parseNumericField('-12.5', 'Latitude')).toEqual({ ok: true, value: -12.5 });
        expect(parseNumericField('0', 'Heading')).toEqual({ ok: true, value: 0 });
    });

    it('rejects empty and whitespace-only input', () => {
        expect(parseNumericField('', 'Altitude')).toEqual({
            ok: false, message: 'Altitude must be a number'
        });
        expect(parseNumericField('   ', 'Speed').ok).toBe(false);
    });

    it('rejects non-numeric input that parseFloat would let through as NaN', () => {
        // The regression this guards: parseFloat('abc') = NaN passed the old
        // range checks (NaN comparisons are all false) and was sent to
        // BlueSky inside a CRE command.
        expect(parseNumericField('abc', 'Latitude')).toEqual({
            ok: false, message: 'Latitude must be a number'
        });
        expect(parseNumericField('NaN', 'Latitude').ok).toBe(false);
        expect(parseNumericField('Infinity', 'Altitude').ok).toBe(false);
    });

    it('rejects trailing garbage instead of truncating like parseFloat', () => {
        expect(parseNumericField('10k', 'Altitude').ok).toBe(false);
        expect(parseNumericField('52.3N', 'Latitude').ok).toBe(false);
        expect(parseNumericField('3,5', 'Speed').ok).toBe(false);
    });

    it('enforces an inclusive range when given', () => {
        const range = { min: -90, max: 90 };
        expect(parseNumericField('90', 'Latitude', range)).toEqual({ ok: true, value: 90 });
        expect(parseNumericField('-90', 'Latitude', range)).toEqual({ ok: true, value: -90 });
        expect(parseNumericField('90.1', 'Latitude', range)).toEqual({
            ok: false, message: 'Latitude must be between -90 and 90'
        });
        expect(parseNumericField('-91', 'Latitude', range).ok).toBe(false);
    });
});
