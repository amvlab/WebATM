// @vitest-environment happy-dom
/**
 * Tests for the namespaced localStorage wrapper. Runs under happy-dom
 * because StorageManager (and the Logger it pulls in) need localStorage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { StorageManager } from './StorageManager';

describe('StorageManager', () => {
    let storage: StorageManager;

    beforeEach(() => {
        localStorage.clear();
        storage = new StorageManager('webatm');
    });

    it('round-trips values through JSON under a namespaced key', () => {
        expect(storage.set('font-size', 14)).toBe(true);
        expect(storage.get<number>('font-size')).toBe(14);
        expect(localStorage.getItem('webatm-font-size')).toBe('14');
    });

    it('stores and retrieves objects and arrays', () => {
        storage.set('opts', { showLabels: true, units: ['m', 'ft'] });
        expect(storage.get('opts')).toEqual({ showLabels: true, units: ['m', 'ft'] });
    });

    it('returns the default for missing keys, null without a default', () => {
        expect(storage.get<number>('missing', 42)).toBe(42);
        expect(storage.get('missing')).toBeNull();
    });

    it('returns the default when stored JSON is corrupt', () => {
        localStorage.setItem('webatm-bad', '{not json');
        expect(storage.get('bad', 'fallback')).toBe('fallback');
    });

    it('removes keys and reports existence via has()', () => {
        storage.set('key', 'value');
        expect(storage.has('key')).toBe(true);
        storage.remove('key');
        expect(storage.has('key')).toBe(false);
    });

    it('lists only keys in its own namespace, without the prefix', () => {
        storage.set('a', 1);
        storage.set('b', 2);
        localStorage.setItem('other-c', '3');
        expect(storage.getKeys().sort()).toEqual(['a', 'b']);
    });

    it('clearNamespace removes only its own keys', () => {
        storage.set('a', 1);
        const other = new StorageManager('other');
        other.set('b', 2);

        storage.clearNamespace();

        expect(storage.has('a')).toBe(false);
        expect(other.get<number>('b')).toBe(2);
    });

    it('isolates instances with different namespaces', () => {
        const other = new StorageManager('other');
        storage.set('key', 'webatm-value');
        other.set('key', 'other-value');
        expect(storage.get('key')).toBe('webatm-value');
        expect(other.get('key')).toBe('other-value');
    });

    describe('getStringWithLegacyMigration', () => {
        it('moves a legacy raw entry under the namespaced key', () => {
            localStorage.setItem('bluesky-server-ip', '10.0.0.5');

            const value = storage.getStringWithLegacyMigration(
                'bluesky-server-ip',
                'bluesky-server-ip'
            );

            expect(value).toBe('10.0.0.5');
            expect(localStorage.getItem('bluesky-server-ip')).toBeNull();
            expect(storage.get<string>('bluesky-server-ip')).toBe('10.0.0.5');
        });

        it('prefers the namespaced value over a lingering legacy entry', () => {
            storage.set('key', 'new');
            localStorage.setItem('key', 'old');

            expect(storage.getStringWithLegacyMigration('key', 'key')).toBe('new');
            // Untouched: migration only runs when the namespaced key is empty
            expect(localStorage.getItem('key')).toBe('old');
        });

        it('returns null when neither key exists', () => {
            expect(storage.getStringWithLegacyMigration('nope', 'nope')).toBeNull();
        });
    });
});
