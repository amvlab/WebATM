import { storage } from '../../utils/StorageManager';

/**
 * A user-saved basemap style: a friendly display name paired with the style
 * JSON URL it resolves to. Persisted so a custom style only has to be typed
 * once and then re-selected by name from the style dropdown.
 */
export interface SavedMapStyle {
    name: string;
    url: string;
}

/** localStorage key (namespaced by StorageManager) for the saved-styles list. */
const STORAGE_KEY = 'custom-map-styles';

/**
 * Coerce arbitrary stored data into a clean SavedMapStyle[]. Anything that is
 * not an array of objects with non-empty string name/url is dropped, so a
 * corrupted or legacy entry can never crash the dropdown rendering.
 */
export function sanitizeStyles(raw: unknown): SavedMapStyle[] {
    if (!Array.isArray(raw)) return [];

    const out: SavedMapStyle[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const name = typeof rec.name === 'string' ? rec.name.trim() : '';
        const url = typeof rec.url === 'string' ? rec.url.trim() : '';
        if (name && url) out.push({ name, url });
    }
    return out;
}

/** Load the saved custom styles, tolerating malformed/missing storage. */
export function loadSavedStyles(): SavedMapStyle[] {
    return sanitizeStyles(storage.get<unknown>(STORAGE_KEY));
}

/** Persist the list of saved custom styles. */
export function persistSavedStyles(styles: SavedMapStyle[]): void {
    storage.set(STORAGE_KEY, styles);
}

/**
 * Add (or update) a saved style. Both name and URL are unique keys: saving a
 * name that already exists overwrites its URL, and saving a URL that already
 * exists (under any name) replaces that entry — so the dropdown never grows a
 * duplicate label or a second option with the same value. Returns a new array.
 */
export function upsertStyle(styles: SavedMapStyle[], name: string, url: string): SavedMapStyle[] {
    const cleanName = name.trim();
    const cleanUrl = url.trim();
    const next = styles.filter(
        s => s.name.toLowerCase() !== cleanName.toLowerCase() && s.url !== cleanUrl
    );
    next.push({ name: cleanName, url: cleanUrl });
    return next;
}

/** Remove the saved style with the given URL. Returns a new array. */
export function removeStyleByUrl(styles: SavedMapStyle[], url: string): SavedMapStyle[] {
    return styles.filter(s => s.url !== url);
}
