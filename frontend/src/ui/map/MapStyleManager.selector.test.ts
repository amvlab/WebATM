// @vitest-environment happy-dom
/**
 * Characterizes the settings-modal style selector wiring in MapStyleManager:
 * which controls are visible for each kind of selection, and the save/delete
 * flow for user-saved custom styles.
 *
 * Regressions covered:
 * - the "Apply Map Style" button must hide when the placeholder is selected
 *   (it used to stay visible after deleting a saved style)
 * - saving a style whose URL duplicates a predefined option must select the
 *   saved optgroup entry, not the predefined option (which hid Delete)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../utils/Logger', () => ({
    logger: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        verbose: vi.fn()
    }
}));

import { MapStyleManager } from './MapStyleManager';
import { loadSavedStyles } from './customStyles';

const PREDEFINED_URL = '/static/map/offline-style-light.json';

function buildSelectorDom(): void {
    document.body.innerHTML = `
        <select id="map-style-select-modal">
            <option value="">Select a map style...</option>
            <option value="https://tiles.example/positron" selected>Positron</option>
            <option value="${PREDEFINED_URL}">Offline Light</option>
            <option value="custom">Custom Style JSON...</option>
        </select>
        <button id="apply-map-style-btn">Apply Map Style</button>
        <button id="delete-saved-style-btn" style="display: none;">Delete Saved Style</button>
        <div id="custom-style-control-modal" style="display: none;">
            <input type="text" id="custom-style-url-modal">
            <input type="text" id="custom-style-name-modal">
            <button id="apply-custom-style-modal">Apply Style</button>
            <button id="save-custom-style-modal">Save Style</button>
        </div>
        <div id="map-style-message"></div>
    `;
}

const el = <T extends HTMLElement>(id: string): T =>
    document.getElementById(id) as T;
const visible = (id: string): boolean => el(id).style.display !== 'none';

function selectValue(value: string): void {
    const select = el<HTMLSelectElement>('map-style-select-modal');
    select.value = value;
    select.dispatchEvent(new Event('change'));
}

function saveStyle(name: string, url: string): void {
    el<HTMLInputElement>('custom-style-url-modal').value = url;
    el<HTMLInputElement>('custom-style-name-modal').value = name;
    el('save-custom-style-modal').click();
}

describe('MapStyleManager style selector', () => {
    beforeEach(() => {
        localStorage.clear();
        buildSelectorDom();
        vi.stubGlobal('alert', vi.fn());
        vi.stubGlobal('confirm', vi.fn(() => true));
        // Map access is irrelevant here: changeStyle() bails out on a null
        // map after the persistence step, which is all these tests need.
        new MapStyleManager(() => null).setupStyleSelector();
    });

    it('shows Apply and hides the custom control for a predefined style', () => {
        selectValue('https://tiles.example/positron');
        expect(visible('apply-map-style-btn')).toBe(true);
        expect(visible('custom-style-control-modal')).toBe(false);
    });

    it('shows the custom control and hides Apply for "custom"', () => {
        selectValue('custom');
        expect(visible('custom-style-control-modal')).toBe(true);
        expect(visible('apply-map-style-btn')).toBe(false);
    });

    it('hides both Apply and the custom control for the placeholder', () => {
        selectValue('https://tiles.example/positron');
        selectValue('');
        expect(visible('apply-map-style-btn')).toBe(false);
        expect(visible('custom-style-control-modal')).toBe(false);
    });

    it('saving a style adds it to the Saved Styles group, selects it, and offers Delete', () => {
        selectValue('custom');
        saveStyle('My Style', 'https://my/style.json');

        const select = el<HTMLSelectElement>('map-style-select-modal');
        const selected = select.selectedOptions[0];
        expect(selected.textContent).toBe('My Style');
        expect(selected.dataset.savedStyle).toBe('true');
        expect(selected.closest('optgroup')?.label).toBe('Saved Styles');
        expect(visible('delete-saved-style-btn')).toBe(true);
        expect(loadSavedStyles()).toEqual([
            { name: 'My Style', url: 'https://my/style.json' }
        ]);
    });

    it('saving a URL that duplicates a predefined option still selects the saved entry', () => {
        selectValue('custom');
        saveStyle('My Light', PREDEFINED_URL);

        const selected = el<HTMLSelectElement>('map-style-select-modal').selectedOptions[0];
        expect(selected.textContent).toBe('My Light');
        expect(selected.dataset.savedStyle).toBe('true');
        expect(visible('delete-saved-style-btn')).toBe(true);
    });

    it('deleting a saved style resets to the placeholder with Apply and Delete hidden', () => {
        selectValue('custom');
        saveStyle('My Style', 'https://my/style.json');

        el('delete-saved-style-btn').click();

        const select = el<HTMLSelectElement>('map-style-select-modal');
        expect(select.value).toBe('');
        expect(visible('apply-map-style-btn')).toBe(false);
        expect(visible('delete-saved-style-btn')).toBe(false);
        expect(loadSavedStyles()).toEqual([]);
        expect(select.querySelector('#saved-custom-styles-group')).toBeNull();
    });
});
