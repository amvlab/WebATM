/**
 * Tests for the pure ranking helper shared by the console autocompletes and
 * the Create Aircraft modal's type dropdown.
 */
import { describe, it, expect } from 'vitest';
import { rankByPrefixThenContains } from './dropdown';

describe('rankByPrefixThenContains', () => {
    const items = ['A320', 'A321', 'B738', 'E75L', 'GLF6'] as const;

    it('returns a copy of the full list for an empty query', () => {
        const ranked = rankByPrefixThenContains(items, '');
        expect(ranked).toEqual([...items]);
        expect(ranked).not.toBe(items);
    });

    it('ranks prefix matches before substring matches', () => {
        expect(rankByPrefixThenContains(items, 'A3')).toEqual(['A320', 'A321']);
        expect(rankByPrefixThenContains(items, '7')).toEqual(['B738', 'E75L']);
        expect(rankByPrefixThenContains(items, 'B7')).toEqual(['B738']);
    });

    it('matches case-insensitively against the items', () => {
        expect(rankByPrefixThenContains(['a320', 'b738'], 'A3')).toEqual(['a320']);
    });

    it('returns an empty list when nothing matches', () => {
        expect(rankByPrefixThenContains(items, 'ZZZ')).toEqual([]);
    });
});
