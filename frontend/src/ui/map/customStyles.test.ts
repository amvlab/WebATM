// @vitest-environment happy-dom
/**
 * Characterizes the saved custom map-style store: sanitization of stored data,
 * unique-by-name-and-url upsert semantics, removal, and round-tripping through
 * localStorage. These guarantees back the "save a custom style by name" feature
 * in the settings map-style selector.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    sanitizeStyles,
    upsertStyle,
    removeStyleByUrl,
    loadSavedStyles,
    persistSavedStyles,
} from './customStyles';

describe('sanitizeStyles', () => {
    it('returns an empty array for non-array / malformed input', () => {
        expect(sanitizeStyles(null)).toEqual([]);
        expect(sanitizeStyles(undefined)).toEqual([]);
        expect(sanitizeStyles('nope')).toEqual([]);
        expect(sanitizeStyles({})).toEqual([]);
    });

    it('keeps only entries with non-empty string name and url, trimming them', () => {
        const raw = [
            { name: '  My Style  ', url: '  https://x/style.json ' },
            { name: '', url: 'https://y' },
            { name: 'no-url', url: '' },
            { name: 'bad', url: 42 },
            'garbage',
            null,
        ];
        expect(sanitizeStyles(raw)).toEqual([
            { name: 'My Style', url: 'https://x/style.json' },
        ]);
    });
});

describe('upsertStyle', () => {
    it('adds a new style', () => {
        const next = upsertStyle([], 'A', 'https://a');
        expect(next).toEqual([{ name: 'A', url: 'https://a' }]);
    });

    it('overwrites the URL when the name already exists (case-insensitive)', () => {
        const start = [{ name: 'A', url: 'https://old' }];
        const next = upsertStyle(start, 'a', 'https://new');
        expect(next).toEqual([{ name: 'a', url: 'https://new' }]);
    });

    it('replaces the entry when the URL already exists under another name', () => {
        const start = [{ name: 'Old Name', url: 'https://same' }];
        const next = upsertStyle(start, 'New Name', 'https://same');
        expect(next).toEqual([{ name: 'New Name', url: 'https://same' }]);
    });

    it('trims name and url and does not mutate the input array', () => {
        const start = [{ name: 'A', url: 'https://a' }];
        const next = upsertStyle(start, '  B  ', '  https://b  ');
        expect(next).toEqual([
            { name: 'A', url: 'https://a' },
            { name: 'B', url: 'https://b' },
        ]);
        expect(start).toHaveLength(1);
    });
});

describe('removeStyleByUrl', () => {
    it('removes the matching entry and leaves the rest', () => {
        const start = [
            { name: 'A', url: 'https://a' },
            { name: 'B', url: 'https://b' },
        ];
        expect(removeStyleByUrl(start, 'https://a')).toEqual([
            { name: 'B', url: 'https://b' },
        ]);
    });

    it('is a no-op when the URL is not present', () => {
        const start = [{ name: 'A', url: 'https://a' }];
        expect(removeStyleByUrl(start, 'https://missing')).toEqual(start);
    });
});

describe('load/persist round-trip', () => {
    beforeEach(() => localStorage.clear());

    it('returns [] when nothing is stored', () => {
        expect(loadSavedStyles()).toEqual([]);
    });

    it('persists and reloads the list, sanitizing on read', () => {
        persistSavedStyles([{ name: 'A', url: 'https://a' }]);
        expect(loadSavedStyles()).toEqual([{ name: 'A', url: 'https://a' }]);
    });

    it('tolerates corrupted stored JSON shape', () => {
        localStorage.setItem('webatm-custom-map-styles', JSON.stringify({ bogus: true }));
        expect(loadSavedStyles()).toEqual([]);
    });
});
