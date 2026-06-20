/**
 * DOM helpers used across UI managers.
 */

export function onDOMReady(callback: () => void): void {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', callback);
    } else {
        callback();
    }
}

/**
 * Escape a string for safe interpolation into HTML. Escapes the five
 * characters significant in HTML text and quoted-attribute contexts, so the
 * result is safe in both `<span>${x}</span>` and `data-foo="${x}"`.
 */
export function escapeHtml(text: string): string {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Look up multiple elements by id in one call.
 * Keys preserve the caller's naming; values may be null if not found.
 */
export function getElements<T extends Record<string, string>>(
    ids: T
): { [K in keyof T]: HTMLElement | null } {
    const out: Record<string, HTMLElement | null> = {};
    for (const key of Object.keys(ids)) {
        out[key] = document.getElementById(ids[key]);
    }
    return out as { [K in keyof T]: HTMLElement | null };
}

/**
 * Apply the "disabled" visual convention used throughout the app:
 * sets the disabled attribute, toggles the `disabled` class, and updates opacity/cursor.
 */
export function setDisabled(element: HTMLElement, disabled: boolean): void {
    if ('disabled' in element) {
        (element as HTMLButtonElement | HTMLInputElement).disabled = disabled;
    }
    element.classList.toggle('disabled', disabled);
    element.style.opacity = disabled ? '0.5' : '1';
    element.style.cursor = disabled ? 'not-allowed' : 'pointer';
}

/**
 * Toggle visibility via display: none / '' (restores the stylesheet default).
 */
export function setVisible(element: HTMLElement, visible: boolean): void {
    element.style.display = visible ? '' : 'none';
}

/**
 * True if element is currently rendered (display !== 'none').
 */
export function isVisible(element: HTMLElement | null): boolean {
    if (!element) return false;
    return element.style.display !== 'none';
}

/**
 * Null-safe form-control setters. Each looks up the element by id and applies
 * the value if present. Used to collapse the repetitive
 *   const x = document.getElementById('id') as HTMLXElement;
 *   if (x) x.checked / x.value / x.textContent = v;
 * pattern that pervades settings-load code.
 */
export function setCheckbox(id: string, checked: boolean): void {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.checked = checked;
}

export function setInputValue(id: string, value: string | number): void {
    const el = document.getElementById(id) as
        | HTMLInputElement
        | HTMLTextAreaElement
        | null;
    if (el) el.value = String(value);
}

export function setSelectValue(id: string, value: string): void {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    if (el) el.value = value;
}

export function setText(id: string, text: string): void {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

/**
 * Look up an element by id and attach an event listener if it exists.
 * Returns true if the listener was bound (the element was found).
 */
export function bindEvent(
    id: string,
    event: string,
    handler: EventListener,
    options?: AddEventListenerOptions | boolean
): boolean {
    const el = document.getElementById(id);
    if (!el) return false;
    el.addEventListener(event, handler, options);
    return true;
}
