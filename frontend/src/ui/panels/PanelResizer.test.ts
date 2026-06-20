// @vitest-environment happy-dom
/**
 * Tests for PanelResizer drag handling, focused on the mousedown guard:
 * a handle whose data-target has no matching config must not enter a drag
 * (it used to add the 'resizing' class and then throw on config.direction,
 * leaving the drag state stuck).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PanelResizer } from './PanelResizer';

function buildLayout(): void {
    document.body.innerHTML = `
        <div class="left-panel"></div>
        <div class="map-container"></div>
        <div class="right-panel"></div>
        <div class="console-container">
            <div class="console-section"></div>
            <div class="echo-section"></div>
        </div>
        <div class="content-area"></div>
        <div class="resize-handle" data-target="left-map"></div>
        <div class="resize-handle" data-target="content-console"></div>
        <div class="resize-handle" data-target="bogus"></div>
    `;
}

function handle(target: string): HTMLElement {
    return document.querySelector(`.resize-handle[data-target="${target}"]`) as HTMLElement;
}

function mousedown(el: HTMLElement): void {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 100 }));
}

function mouseup(): void {
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 100 }));
}

describe('PanelResizer mousedown handling', () => {
    let resizer: PanelResizer;

    beforeEach(() => {
        localStorage.clear();
        buildLayout();
        resizer = new PanelResizer();
    });

    afterEach(() => {
        resizer.destroy();
        document.body.className = '';
        document.body.style.cursor = '';
    });

    it('ignores a handle whose data-target has no config (no stuck drag)', () => {
        const bogus = handle('bogus');
        expect(() => mousedown(bogus)).not.toThrow();

        // The drag never started: no visual/drag side effects were applied.
        expect(bogus.classList.contains('resizing')).toBe(false);
        expect(document.body.classList.contains('no-select')).toBe(false);
        expect(document.body.style.cursor).toBe('');
    });

    it('enters drag state for a configured horizontal handle', () => {
        const h = handle('left-map');
        mousedown(h);

        expect(h.classList.contains('resizing')).toBe(true);
        expect(document.body.classList.contains('no-select')).toBe(true);
        expect(document.body.style.cursor).toBe('col-resize');
    });

    it('uses the row cursor for a vertical handle', () => {
        mousedown(handle('content-console'));
        expect(document.body.style.cursor).toBe('row-resize');
    });

    it('mouseup ends the drag, resets the cursor, and persists the layout', () => {
        const h = handle('left-map');
        mousedown(h);
        mouseup();

        expect(h.classList.contains('resizing')).toBe(false);
        expect(document.body.classList.contains('no-select')).toBe(false);
        expect(document.body.style.cursor).toBe('');
        // Layout is saved under the StorageManager namespace.
        expect(localStorage.getItem('webatm-panel-layout')).not.toBeNull();
    });
});
