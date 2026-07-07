// @vitest-environment happy-dom
/**
 * Verifies ShapeDrawingManager wires its name-modal handlers through the
 * BaseDrawingManager teardown signal, validates shape names against BlueSky's
 * command syntax, and can't send the finished shape command twice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ShapeDrawingManager } from './ShapeDrawingManager';
import type { MapDisplay } from '../MapDisplay';
import type { MapMouseEvent } from 'maplibre-gl';
import type { App } from '../../../core/App';
import type { NavaidSnapper } from '../navdata/NavaidSnapper';

vi.mock('../../ModalManager', () => ({
    modalManager: { open: vi.fn(() => document.createElement('div')), close: vi.fn() },
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

/** Minimal MapLibre map double covering what the drawing flow touches. */
class FakeMap {
    private sources = new Set<string>();
    private layers = new Set<string>();
    public handlers = new Map<string, (e: MapMouseEvent) => void>();

    getSource(id: string): { setData: () => void } | undefined {
        return this.sources.has(id) ? { setData: vi.fn() } : undefined;
    }
    addSource(id: string): void {
        this.sources.add(id);
    }
    removeSource(id: string): void {
        this.sources.delete(id);
    }
    getLayer(id: string): { id: string } | undefined {
        return this.layers.has(id) ? { id } : undefined;
    }
    addLayer(spec: { id: string }): void {
        this.layers.add(spec.id);
    }
    removeLayer(id: string): void {
        this.layers.delete(id);
    }
    getCanvas(): { style: { cursor: string } } {
        return { style: { cursor: '' } };
    }
    on(event: string, handler: (e: MapMouseEvent) => void): void {
        this.handlers.set(event, handler);
    }
    off(event: string): void {
        this.handlers.delete(event);
    }
    setLayoutProperty(): void {}
}

describe('ShapeDrawingManager create validation and finish', () => {
    let alertMock: ReturnType<typeof vi.fn>;
    let fakeMap: FakeMap;
    let sendCommandMock: ReturnType<typeof vi.fn>;
    let manager: ShapeDrawingManager;

    beforeEach(() => {
        setupDom();
        alertMock = vi.fn();
        window.alert = alertMock as unknown as typeof window.alert;

        fakeMap = new FakeMap();
        const mapDisplay = { getMap: () => fakeMap } as unknown as MapDisplay;
        sendCommandMock = vi.fn(() => Promise.resolve(true));
        const app = {
            sendCommand: sendCommandMock,
            getConsole: () => null,
        } as unknown as App;
        const snapper = {
            snap: () => null,
            highlight: vi.fn(),
            clearHighlight: vi.fn(),
        } as unknown as NavaidSnapper;
        manager = new ShapeDrawingManager(mapDisplay, app, snapper);
    });

    afterEach(() => {
        manager.destroy();
        vi.restoreAllMocks();
    });

    function fillModal(name: string): void {
        (document.getElementById('polygon-name-input') as HTMLInputElement).value = name;
    }

    function clickCreate(): void {
        (document.getElementById('create-polygon-btn') as HTMLButtonElement).click();
    }

    function mapClick(lat: number, lng: number): void {
        fakeMap.handlers.get('click')?.({ lngLat: { lat, lng } } as MapMouseEvent);
    }

    function mapRightClick(): void {
        fakeMap.handlers.get('contextmenu')?.({ preventDefault: vi.fn() } as unknown as MapMouseEvent);
    }

    it('rejects names containing commas (BlueSky argument separator)', () => {
        fillModal('TMA,1');
        clickCreate();

        expect(alertMock).toHaveBeenCalledWith('Shape name cannot contain spaces or commas');
        expect(manager.isDrawing()).toBe(false);
    });

    it('draws and sends exactly one command on finish', async () => {
        fillModal('AREA1');
        clickCreate();
        expect(manager.isDrawing()).toBe(true);

        mapClick(52, 4);
        mapClick(53, 5);
        mapClick(52.5, 6);
        mapRightClick();

        expect(sendCommandMock).toHaveBeenCalledExactlyOnceWith(
            'POLY AREA1,52.000000,4.000000,53.000000,5.000000,52.500000,6.000000'
        );
        // Drawing mode ends immediately, not only after the send resolves.
        expect(manager.isDrawing()).toBe(false);
    });

    it('does not send twice when right-click fires again while the send is in flight', async () => {
        let resolveSend: (v: boolean) => void = () => {};
        sendCommandMock.mockImplementation(
            () => new Promise<boolean>((resolve) => { resolveSend = resolve; })
        );

        fillModal('AREA2');
        clickCreate();
        mapClick(52, 4);
        mapClick(53, 5);
        mapClick(52.5, 6);

        mapRightClick();
        mapRightClick();

        resolveSend(true);
        await Promise.resolve();

        expect(sendCommandMock).toHaveBeenCalledTimes(1);
    });
});
