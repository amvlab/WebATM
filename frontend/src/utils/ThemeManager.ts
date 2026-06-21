/**
 * Theme Manager
 *
 * Single source of truth for the UI colour theme. The actual colours live in
 * CSS as design tokens (see `WebATM/static/css/style.css`); this class only
 * decides which token set is active by setting `data-theme` on <html>.
 *
 * Three preferences are supported:
 *   - 'dark'   force the dark token set (the default)
 *   - 'light'  force the light token set
 *   - 'system' follow the OS `prefers-color-scheme` setting, live
 *
 * The preference is persisted via StorageManager under the `theme` key. To
 * avoid a flash of the wrong theme on load, the resolved theme is also applied
 * before first paint by the inline script in `templates/index.html`; this
 * class keeps that in sync and reacts to OS / preference changes at runtime.
 */

import { logger } from './Logger';
import { storage } from './StorageManager';

export type ThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

const STORAGE_KEY = 'theme';
const DEFAULT_PREFERENCE: ThemePreference = 'dark';

type ThemeListener = (resolved: ResolvedTheme, preference: ThemePreference) => void;

class ThemeManager {
    private preference: ThemePreference = DEFAULT_PREFERENCE;
    private mediaQuery: MediaQueryList | null = null;
    private listeners = new Set<ThemeListener>();
    private initialized = false;

    /**
     * Read the saved preference and apply it. Safe to call multiple times; only
     * the first call wires up the OS-change listener.
     */
    public init(): void {
        this.preference = this.readSavedPreference();

        if (!this.initialized) {
            if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
                this.mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
                this.mediaQuery.addEventListener('change', this.handleSystemChange);
            }
            this.initialized = true;
        }

        this.apply();
        logger.info('ThemeManager', `Theme initialized: ${this.preference} (resolved: ${this.getResolvedTheme()})`);
    }

    /** The user's stored preference (dark | light | system). */
    public getPreference(): ThemePreference {
        return this.preference;
    }

    /** The theme actually applied right now (dark | light). */
    public getResolvedTheme(): ResolvedTheme {
        return this.resolve(this.preference);
    }

    /** Change the preference, persist it, and apply immediately. */
    public setPreference(preference: ThemePreference): void {
        this.preference = preference;
        storage.set(STORAGE_KEY, preference);
        this.apply();
        logger.info('ThemeManager', `Theme set to: ${preference} (resolved: ${this.getResolvedTheme()})`);
    }

    /**
     * Subscribe to theme changes. Returns an unsubscribe function. The listener
     * is invoked immediately with the current state.
     */
    public subscribe(listener: ThemeListener): () => void {
        this.listeners.add(listener);
        listener(this.getResolvedTheme(), this.preference);
        return () => this.listeners.delete(listener);
    }

    private readSavedPreference(): ThemePreference {
        const saved = storage.get<ThemePreference>(STORAGE_KEY, DEFAULT_PREFERENCE);
        if (saved === 'dark' || saved === 'light' || saved === 'system') {
            return saved;
        }
        return DEFAULT_PREFERENCE;
    }

    private resolve(preference: ThemePreference): ResolvedTheme {
        if (preference === 'system') {
            return this.mediaQuery?.matches ? 'light' : 'dark';
        }
        return preference;
    }

    private apply(): void {
        const resolved = this.getResolvedTheme();
        if (typeof document !== 'undefined') {
            document.documentElement.setAttribute('data-theme', resolved);
        }
        this.notify(resolved);
    }

    private handleSystemChange = (): void => {
        if (this.preference === 'system') {
            this.apply();
        }
    };

    private notify(resolved: ResolvedTheme): void {
        this.listeners.forEach((listener) => {
            try {
                listener(resolved, this.preference);
            } catch (error) {
                logger.error('ThemeManager', 'Theme listener error:', error);
            }
        });
    }
}

export const themeManager = new ThemeManager();
