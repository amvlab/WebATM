// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DisplayOptionsPanel } from './DisplayOptionsPanel';
import { StateManager } from '../../../core/StateManager';
import { storage } from '../../../utils/StorageManager';

// loadAvailableAircraftModels fetches the model catalog during setup;
// let it fail fast and resolve to [].
vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in tests')));

function buildDom(): void {
    document.body.innerHTML = `
        <div class="panel display-panel">
            <div class="panel-content" id="display-content">
                <input type="checkbox" id="show-3d-overlay">
                <label id="show-aircraft-labels-container">
                    <input type="checkbox" id="show-aircraft-labels" checked>
                </label>
                <label id="show-aircraft-id-container">
                    <input type="checkbox" id="show-aircraft-id" checked>
                </label>
                <label id="show-aircraft-speed-container">
                    <input type="checkbox" id="show-aircraft-speed" checked>
                </label>
                <label id="show-aircraft-altitude-container">
                    <input type="checkbox" id="show-aircraft-altitude" checked>
                </label>
                <label id="show-aircraft-type-container">
                    <input type="checkbox" id="show-aircraft-type" checked>
                </label>
                <input type="checkbox" id="show-routes" checked>
                <label id="show-route-lines-container">
                    <input type="checkbox" id="show-route-lines" checked>
                </label>
                <label id="show-route-labels-container">
                    <input type="checkbox" id="show-route-labels" checked>
                </label>
                <label id="show-route-points-container">
                    <input type="checkbox" id="show-route-points" checked>
                </label>
            </div>
        </div>
    `;
}

function createPanel(): { panel: DisplayOptionsPanel; stateManager: StateManager } {
    const panel = new DisplayOptionsPanel();
    panel.init();
    const stateManager = new StateManager();
    panel.setStateManager(stateManager);
    return { panel, stateManager };
}

function checkbox(id: string): HTMLInputElement {
    return document.getElementById(id) as HTMLInputElement;
}

function containerDisplay(id: string): string {
    return (document.getElementById(id) as HTMLElement).style.display;
}

describe('DisplayOptionsPanel', () => {
    beforeEach(() => {
        localStorage.clear();
        buildDom();
    });

    describe('legacy render-mode migration', () => {
        it('seeds a missing show-3d-overlay from render-mode=3d and removes the legacy key', () => {
            storage.set('render-mode', '3d');

            const { stateManager } = createPanel();

            expect(stateManager.getDisplayOptions().show3DOverlay).toBe(true);
            expect(storage.get<boolean>('show-3d-overlay')).toBe(true);
            expect(storage.has('render-mode')).toBe(false);
            expect(checkbox('show-3d-overlay').checked).toBe(true);
        });

        it('never overrides an explicitly stored show-3d-overlay=false', () => {
            // Regression: the overlay used to flip back on at every page
            // load for users who once had the legacy 3d render mode.
            storage.set('render-mode', '3d');
            storage.set('show-3d-overlay', false);

            const { stateManager } = createPanel();

            expect(stateManager.getDisplayOptions().show3DOverlay).toBe(false);
            expect(storage.get<boolean>('show-3d-overlay')).toBe(false);
            expect(storage.has('render-mode')).toBe(false);
            expect(checkbox('show-3d-overlay').checked).toBe(false);
        });

        it('discards a non-3d legacy render-mode without touching the overlay setting', () => {
            storage.set('render-mode', '2d');

            const { stateManager } = createPanel();

            expect(stateManager.getDisplayOptions().show3DOverlay).toBe(false);
            expect(storage.has('render-mode')).toBe(false);
        });
    });

    describe('sub-option rows on load', () => {
        it('hides the sub-option rows of a master stored as off, keeping sub values', () => {
            storage.set('show-aircraft-labels', false);
            storage.set('show-aircraft-id', true);

            const { stateManager } = createPanel();

            expect(containerDisplay('show-aircraft-id-container')).toBe('none');
            expect(containerDisplay('show-aircraft-type-container')).toBe('none');
            expect(checkbox('show-aircraft-labels').checked).toBe(false);
            // Sub-option values are preserved, only their rows collapse
            expect(checkbox('show-aircraft-id').checked).toBe(true);
            expect(stateManager.getDisplayOptions().showAircraftLabels).toBe(false);
            expect(stateManager.getDisplayOptions().showAircraftId).toBe(true);
        });

        it('shows the sub-option rows when the master is stored as on', () => {
            storage.set('show-routes', true);

            createPanel();

            expect(containerDisplay('show-route-lines-container')).toBe('block');
            expect(containerDisplay('show-route-points-container')).toBe('block');
        });

        it('hides the route sub-option rows when routes are stored as off', () => {
            storage.set('show-routes', false);

            const { stateManager } = createPanel();

            expect(containerDisplay('show-route-lines-container')).toBe('none');
            expect(containerDisplay('show-route-labels-container')).toBe('none');
            expect(containerDisplay('show-route-points-container')).toBe('none');
            expect(stateManager.getDisplayOptions().showRoutes).toBe(false);
        });
    });

    describe('routes master toggle', () => {
        it('drives sub checkboxes, containers, storage and state like other masters', () => {
            const { stateManager } = createPanel();

            const master = checkbox('show-routes');
            master.checked = false;
            master.dispatchEvent(new Event('change'));

            expect(stateManager.getDisplayOptions().showRoutes).toBe(false);
            expect(stateManager.getDisplayOptions().showRouteLines).toBe(false);
            expect(stateManager.getDisplayOptions().showRoutePoints).toBe(false);
            expect(checkbox('show-route-lines').checked).toBe(false);
            expect(containerDisplay('show-route-labels-container')).toBe('none');
            expect(storage.get<boolean>('show-routes')).toBe(false);
            expect(storage.get<boolean>('show-route-lines')).toBe(false);
        });

        it('re-enabling the master turns the group back on', () => {
            const { stateManager } = createPanel();
            const master = checkbox('show-routes');

            master.checked = false;
            master.dispatchEvent(new Event('change'));
            master.checked = true;
            master.dispatchEvent(new Event('change'));

            expect(stateManager.getDisplayOptions().showRoutes).toBe(true);
            expect(stateManager.getDisplayOptions().showRouteLabels).toBe(true);
            expect(containerDisplay('show-route-lines-container')).toBe('block');
        });
    });

    describe('independent sub-option', () => {
        it('toggling a sub-option only updates its own flag', () => {
            const { stateManager } = createPanel();

            const sub = checkbox('show-route-lines');
            sub.checked = false;
            sub.dispatchEvent(new Event('change'));

            expect(stateManager.getDisplayOptions().showRouteLines).toBe(false);
            expect(stateManager.getDisplayOptions().showRoutes).toBe(true);
            expect(storage.get<boolean>('show-route-lines')).toBe(false);
        });
    });
});
