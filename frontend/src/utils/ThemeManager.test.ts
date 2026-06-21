// @vitest-environment happy-dom
/**
 * Tests for ThemeManager. Runs under happy-dom because the manager reads
 * localStorage, sets `data-theme` on <html>, and queries `matchMedia`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { themeManager } from './ThemeManager';

describe('ThemeManager', () => {
    beforeEach(() => {
        localStorage.clear();
        document.documentElement.removeAttribute('data-theme');
        // Reset to a known preference between tests (singleton holds state).
        themeManager.setPreference('dark');
    });

    it('defaults to dark when nothing is saved', () => {
        localStorage.clear();
        themeManager.init();
        expect(themeManager.getPreference()).toBe('dark');
        expect(themeManager.getResolvedTheme()).toBe('dark');
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('persists the preference under the namespaced key and applies it', () => {
        themeManager.setPreference('light');
        expect(themeManager.getPreference()).toBe('light');
        expect(themeManager.getResolvedTheme()).toBe('light');
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        expect(localStorage.getItem('webatm-theme')).toBe('"light"');
    });

    it('reads a saved preference on init', () => {
        localStorage.setItem('webatm-theme', '"light"');
        themeManager.init();
        expect(themeManager.getPreference()).toBe('light');
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('falls back to dark for an invalid saved value', () => {
        localStorage.setItem('webatm-theme', '"chartreuse"');
        themeManager.init();
        expect(themeManager.getPreference()).toBe('dark');
    });

    it('resolves "system" to a concrete light/dark theme', () => {
        themeManager.setPreference('system');
        expect(themeManager.getPreference()).toBe('system');
        // happy-dom reports no light preference, so system resolves to dark.
        expect(['dark', 'light']).toContain(themeManager.getResolvedTheme());
        expect(document.documentElement.getAttribute('data-theme')).toBe(
            themeManager.getResolvedTheme()
        );
    });

    it('notifies subscribers immediately and on change, and unsubscribes', () => {
        const seen: string[] = [];
        const unsubscribe = themeManager.subscribe((resolved) => seen.push(resolved));
        expect(seen).toEqual(['dark']); // immediate call with current state

        themeManager.setPreference('light');
        expect(seen).toEqual(['dark', 'light']);

        unsubscribe();
        themeManager.setPreference('dark');
        expect(seen).toEqual(['dark', 'light']); // no further notifications
    });
});
