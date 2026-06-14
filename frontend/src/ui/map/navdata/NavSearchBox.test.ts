// @vitest-environment happy-dom
/**
 * Tests for NavSearchBox.setVisible - the show/hide behaviour behind the
 * "Search Bar" display option. Only the visibility logic is covered here;
 * the search/fetch flow needs the navdata backend.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NavSearchBox } from './NavSearchBox';
import type { MapDisplay } from '../MapDisplay';

function mountMarkup(): void {
    document.body.innerHTML = `
        <div id="nav-search" class="nav-search">
            <input id="nav-search-input" type="text">
            <div id="nav-search-results" style="display: none;"></div>
        </div>
    `;
}

function createMapDisplayMock(): MapDisplay {
    return { setCenter: vi.fn() } as unknown as MapDisplay;
}

describe('NavSearchBox.setVisible', () => {
    let box: NavSearchBox;

    beforeEach(() => {
        mountMarkup();
        box = new NavSearchBox(createMapDisplayMock());
        box.init();
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    const container = () => document.getElementById('nav-search') as HTMLElement;
    const results = () => document.getElementById('nav-search-results') as HTMLElement;

    it('hides the search box by setting display:none', () => {
        box.setVisible(false);
        expect(container().style.display).toBe('none');
    });

    it('shows the search box by clearing the inline display', () => {
        box.setVisible(false);
        box.setVisible(true);
        // Empty string reverts to the stylesheet's default (visible).
        expect(container().style.display).toBe('');
    });

    it('closes the results dropdown when hidden', () => {
        // Pretend the dropdown was open.
        results().style.display = 'block';
        box.setVisible(false);
        expect(results().style.display).toBe('none');
    });

    it('is a safe no-op when the markup is absent (init not run)', () => {
        const orphan = new NavSearchBox(createMapDisplayMock());
        expect(() => orphan.setVisible(false)).not.toThrow();
        expect(() => orphan.setVisible(true)).not.toThrow();
    });
});
