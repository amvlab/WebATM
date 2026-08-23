// @vitest-environment happy-dom
/**
 * Tests for the aircraft map-draw state machine.
 *
 * Pins the two regressions of the draw lifecycle:
 * - Re-entering map mode while a draw is already active must replace the old
 *   map handlers, not stack them. Stacked handlers made a single click push
 *   two identical points, instantly creating the aircraft with heading 0 -
 *   and the orphaned handler could never be removed again.
 * - Escape must cancel the draw in any phase, including before the first
 *   (position) click, matching the other drawing modes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AircraftCreationManager } from './AircraftCreationManager';
import type { AircraftCreationData } from './AircraftCreationForm';
import type { MapDisplay } from '../MapDisplay';
import type { NavaidSnapper } from '../navdata/NavaidSnapper';
import type { MapMouseEvent } from 'maplibre-gl';

function createFakeMap() {
    const handlers: Record<string, Array<(e: unknown) => void>> = {};
    const sources: Record<string, { setData: ReturnType<typeof vi.fn> }> = {};
    const layers: Record<string, unknown> = {};
    return {
        handlers,
        doubleClickZoom: { enable: vi.fn(), disable: vi.fn() },
        getCanvas: () => ({ style: { cursor: '' } }),
        on: vi.fn((event: string, handler: (e: unknown) => void) => {
            (handlers[event] ??= []).push(handler);
        }),
        off: vi.fn((event: string, handler: (e: unknown) => void) => {
            handlers[event] = (handlers[event] ?? []).filter(h => h !== handler);
        }),
        fire(event: string, e: unknown) {
            [...(handlers[event] ?? [])].forEach(h => h(e));
        },
        getSource: (id: string) => sources[id],
        addSource: (id: string) => {
            sources[id] = { setData: vi.fn() };
        },
        removeSource: (id: string) => {
            delete sources[id];
        },
        getLayer: (id: string) => layers[id],
        addLayer: (spec: { id: string }) => {
            layers[spec.id] = spec;
        },
        removeLayer: (id: string) => {
            delete layers[id];
        }
    };
}

function clickEvent(lat: number, lng: number, detail = 1): MapMouseEvent {
    return { lngLat: { lat, lng }, originalEvent: { detail } } as unknown as MapMouseEvent;
}

function creationData(id: string): AircraftCreationData {
    return {
        id,
        actype: 'B738',
        altDisplay: 10000,
        altUnit: 'ft',
        spdDisplay: 250,
        spdUnit: 'knots'
    };
}

/** Typed access to the private map-mode entry point the form calls. */
interface DrawApi {
    startAircraftDrawing(data: AircraftCreationData): void;
}

describe('AircraftCreationManager map drawing', () => {
    let map: ReturnType<typeof createFakeMap>;
    let manager: AircraftCreationManager;
    let draw: DrawApi;
    const app = { sendCommand: vi.fn(), getConsole: () => null };

    beforeEach(() => {
        document.body.innerHTML =
            '<div id="drawing-banner" style="display: none;">' +
            '<span id="drawing-banner-text"></span></div>';
        map = createFakeMap();
        app.sendCommand.mockReset();
        window.app = app as unknown as Window['app'];
        const mapDisplay = { getMap: () => map } as unknown as MapDisplay;
        const snapper = {
            snap: vi.fn(() => null),
            highlight: vi.fn(),
            clearHighlight: vi.fn()
        } as unknown as NavaidSnapper;
        manager = new AircraftCreationManager(mapDisplay, snapper);
        draw = manager as unknown as DrawApi;
    });

    afterEach(() => {
        manager.destroy();
        delete window.app;
        document.body.innerHTML = '';
    });

    function bannerVisible(): boolean {
        const banner = document.getElementById('drawing-banner') as HTMLElement;
        return banner.style.display !== 'none';
    }

    it('a single click sets the position but never completes the draw', () => {
        draw.startAircraftDrawing(creationData('AC1'));
        map.fire('click', clickEvent(52, 4));

        expect(app.sendCommand).not.toHaveBeenCalled();
        expect(bannerVisible()).toBe(true);
    });

    it('completes with the bearing between the two clicks', () => {
        draw.startAircraftDrawing(creationData('AC1'));
        map.fire('click', clickEvent(52, 4));
        map.fire('click', clickEvent(53, 4)); // due north of the first click

        expect(app.sendCommand).toHaveBeenCalledWith('CRE AC1,B738,52,4,0,10000,250');
        expect(bannerVisible()).toBe(false);
    });

    it('re-entering map mode mid-draw replaces the handlers instead of stacking them', () => {
        draw.startAircraftDrawing(creationData('AC1'));
        draw.startAircraftDrawing(creationData('AC2'));

        // One click handler only - stacked handlers would double-push each
        // click and complete the draw instantly with heading 0.
        expect(map.handlers['click']).toHaveLength(1);

        map.fire('click', clickEvent(52, 4));
        expect(app.sendCommand).not.toHaveBeenCalled();

        map.fire('click', clickEvent(52, 5));
        expect(app.sendCommand).toHaveBeenCalledTimes(1);
        const command = app.sendCommand.mock.calls[0][0] as string;
        expect(command.startsWith('CRE AC2,')).toBe(true);
    });

    it('Escape cancels the draw before the first click', () => {
        draw.startAircraftDrawing(creationData('AC1'));
        expect(bannerVisible()).toBe(true);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(bannerVisible()).toBe(false);
        expect(map.handlers['click'] ?? []).toHaveLength(0);
        map.fire('click', clickEvent(52, 4));
        map.fire('click', clickEvent(53, 4));
        expect(app.sendCommand).not.toHaveBeenCalled();
    });

    it('a double-click places the position once instead of completing the draw', () => {
        draw.startAircraftDrawing(creationData('AC1'));
        // A double-click delivers two click events; the second carries
        // detail=2 and must not be treated as the heading click.
        map.fire('click', clickEvent(52, 4));
        map.fire('click', clickEvent(52, 4, 2));

        expect(app.sendCommand).not.toHaveBeenCalled();
        expect(bannerVisible()).toBe(true);

        // The draw is still live: a real heading click completes it.
        map.fire('click', clickEvent(53, 4));
        expect(app.sendCommand).toHaveBeenCalledWith('CRE AC1,B738,52,4,0,10000,250');
    });

    it('ignores a heading click on the exact spawn position', () => {
        draw.startAircraftDrawing(creationData('AC1'));
        // Both clicks snapping to the same navaid yields identical points,
        // whose bearing is meaningless.
        map.fire('click', clickEvent(52, 4));
        map.fire('click', clickEvent(52, 4));

        expect(app.sendCommand).not.toHaveBeenCalled();

        map.fire('click', clickEvent(53, 4));
        expect(app.sendCommand).toHaveBeenCalledWith('CRE AC1,B738,52,4,0,10000,250');
    });

    it('suspends double-click zoom while drawing and restores it after', () => {
        draw.startAircraftDrawing(creationData('AC1'));
        expect(map.doubleClickZoom.disable).toHaveBeenCalledTimes(1);
        expect(map.doubleClickZoom.enable).not.toHaveBeenCalled();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(map.doubleClickZoom.enable).toHaveBeenCalledTimes(1);
    });

    it('Escape also cancels after the position click', () => {
        draw.startAircraftDrawing(creationData('AC1'));
        map.fire('click', clickEvent(52, 4));

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(bannerVisible()).toBe(false);
        expect(map.handlers['click'] ?? []).toHaveLength(0);
        expect(map.handlers['mousemove'] ?? []).toHaveLength(0);
        expect(map.getLayer('temp-aircraft-position-layer')).toBeUndefined();
        expect(map.getSource('temp-aircraft-position')).toBeUndefined();
    });
});
