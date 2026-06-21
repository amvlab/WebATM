// @vitest-environment happy-dom
/**
 * Verifies ShapeDrawingManager wires its name-modal handlers through the
 * BaseDrawingManager teardown signal, so destroy() (App.cleanup) removes them
 * rather than leaving them driving a torn-down manager.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ShapeDrawingManager } from './ShapeDrawingManager';
import type { MapDisplay } from '../MapDisplay';
import type { App } from '../../../core/App';
import type { NavaidSnapper } from '../navdata/NavaidSnapper';

vi.mock('../../ModalManager', () => ({
    modalManager: { open: vi.fn(), close: vi.fn() },
}));

function setupDom(): void {
    document.body.innerHTML = `
        <button id="create-polygon-btn"></button>
        <select id="shape-type-select"><option value="area">area</option><option value="line">line</option></select>
        <input id="polygon-name-input" />
        <input id="polygon-top-input" />
        <input id="polygon-bottom-input" />
        <div id="polygon-modal-title"></div>
        <div id="altitude-fields"></div>
        <button id="draw-shape-btn"></button>
    `;
}

function createManager(): ShapeDrawingManager {
    const mapDisplay = { getMap: () => null } as unknown as MapDisplay;
    const app = {} as unknown as App;
    const snapper = {} as unknown as NavaidSnapper;
    return new ShapeDrawingManager(mapDisplay, app, snapper);
}

describe('ShapeDrawingManager teardown', () => {
    let alertMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        setupDom();
        alertMock = vi.fn();
        window.alert = alertMock as unknown as typeof window.alert;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('handles the Create button while alive and stops after destroy()', () => {
        const manager = createManager();
        const createBtn = document.getElementById('create-polygon-btn') as HTMLButtonElement;

        // Empty name -> onCreatePolygonClick alerts, proving the handler ran.
        createBtn.click();
        expect(alertMock).toHaveBeenCalledTimes(1);

        manager.destroy();
        alertMock.mockClear();
        createBtn.click();
        expect(alertMock).not.toHaveBeenCalled();
    });

    it('handles shape-type changes while alive and stops after destroy()', () => {
        const manager = createManager();
        const select = document.getElementById('shape-type-select') as HTMLSelectElement;
        const title = document.getElementById('polygon-modal-title') as HTMLElement;

        select.value = 'line';
        select.dispatchEvent(new Event('change'));
        expect(title.textContent).toBe('Draw Line');

        manager.destroy();
        select.value = 'area';
        select.dispatchEvent(new Event('change'));
        // Handler removed: title stays on its last value.
        expect(title.textContent).toBe('Draw Line');
    });
});
