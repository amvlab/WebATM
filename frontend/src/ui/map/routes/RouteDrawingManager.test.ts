// @vitest-environment happy-dom
/**
 * Tests for the leader-anchor resolution in RouteDrawingManager: the banner
 * label must be derived from the same decision that picks the anchor, and it
 * must be snapshotted at draw start so it can't drift if route data changes
 * mid-draw.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RouteDrawingManager } from './RouteDrawingManager';
import { DrawingPoint } from '../BaseDrawingManager';
import type { MapDisplay } from '../MapDisplay';
import type { App } from '../../../core/App';
import type { StateManager } from '../../../core/StateManager';
import type { NavaidSnapper } from '../navdata/NavaidSnapper';
import type { RouteData } from '../../../data/types';

/** Subclass that exposes the protected point hook so we can drive the draw. */
class TestableRouteDrawingManager extends RouteDrawingManager {
    public addPoint(p: DrawingPoint): void {
        this.onPointAdded(p);
    }
}

function bannerText(): string {
    return document.getElementById('drawing-banner-text')?.textContent ?? '';
}

describe('RouteDrawingManager leader anchor', () => {
    let routeData: RouteData | null;
    let aircraft: { lat: number; lon: number } | null;

    function makeManager(): TestableRouteDrawingManager {
        // getMap() returns null so enableMapDrawing / preview short-circuit;
        // we only care about the banner + anchor bookkeeping here.
        const mapDisplay = { getMap: () => null } as unknown as MapDisplay;
        const snapper = { clearHighlight: vi.fn() } as unknown as NavaidSnapper;
        const app = {
            getRouteData: () => routeData,
        } as unknown as App;
        const stateManager = {
            subscribe: vi.fn(),
            getState: () => ({ selectedAircraft: 'AC1', displayOptions: { mapLabelsTextSize: 12 } }),
            getAircraftById: () => (aircraft ? { id: 'AC1', ...aircraft } : null),
        } as unknown as StateManager;
        return new TestableRouteDrawingManager(mapDisplay, app, stateManager, snapper);
    }

    beforeEach(() => {
        document.body.innerHTML =
            '<button id="draw-route-btn"></button>' +
            '<div id="drawing-banner"><span id="drawing-banner-text"></span></div>';
        routeData = null;
        aircraft = { lat: 52, lon: 4 };
    });

    it('labels the anchor "aircraft" when the aircraft has no existing route', () => {
        makeManager().toggleDrawing();
        expect(bannerText()).toContain('leader from aircraft');
    });

    it('labels the anchor "last existing waypoint" when a matching route exists', () => {
        routeData = {
            acid: 'AC1', iactwp: 0, aclat: 52, aclon: 4,
            wplat: [50, 51], wplon: [5, 6], wpalt: [], wpspd: [], wpname: [],
        };
        makeManager().toggleDrawing();
        expect(bannerText()).toContain('leader from last existing waypoint');
    });

    it('falls back to "aircraft" when wplat/wplon lengths disagree (malformed route)', () => {
        // Previously the label-only check ignored wplon length and would have
        // mislabelled this as "last existing waypoint"; now it matches the
        // anchor decision, which requires equal-length parallel arrays.
        routeData = {
            acid: 'AC1', iactwp: 0, aclat: 52, aclon: 4,
            wplat: [50, 51], wplon: [5], wpalt: [], wpspd: [], wpname: [],
        };
        makeManager().toggleDrawing();
        expect(bannerText()).toContain('leader from aircraft');
    });

    it('snapshots the label at draw start so it does not drift mid-draw', () => {
        // Start with no route -> label "aircraft".
        const manager = makeManager();
        manager.toggleDrawing();
        expect(bannerText()).toContain('leader from aircraft');

        // Route data arrives mid-draw; the snapshotted label must NOT flip.
        routeData = {
            acid: 'AC1', iactwp: 0, aclat: 52, aclon: 4,
            wplat: [50], wplon: [5], wpalt: [], wpspd: [], wpname: [],
        };
        manager.addPoint({ lat: 53, lng: 7 });
        expect(bannerText()).toContain('leader from aircraft');
        expect(bannerText()).not.toContain('last existing waypoint');
    });
});

describe('RouteDrawingManager finish hand-off to the constraints modal', () => {
    /** Minimal fake MapLibre map: records on/off so we can assert handler
     *  teardown; sources/layers are no-ops (getSource/getLayer stay empty). */
    function makeFakeMap() {
        const handlers = new Map<string, Set<unknown>>();
        return {
            handlers,
            on(ev: string, fn: unknown) {
                if (!handlers.has(ev)) handlers.set(ev, new Set());
                handlers.get(ev)!.add(fn);
            },
            off(ev: string, fn: unknown) {
                handlers.get(ev)?.delete(fn);
            },
            doubleClickZoom: { enable: () => undefined, disable: () => undefined },
            getCanvas: () => ({ style: {} as CSSStyleDeclaration }),
            getSource: () => undefined,
            addSource: () => undefined,
            getLayer: () => undefined,
            addLayer: () => undefined,
            removeLayer: () => undefined,
            removeSource: () => undefined,
        };
    }

    function pressEnter(): void {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }

    beforeEach(() => {
        document.body.innerHTML =
            '<button id="draw-route-btn"></button>' +
            '<div id="drawing-banner"><span id="drawing-banner-text"></span></div>' +
            '<div id="route-constraints-modal" class="modal" style="display: none;">' +
            '  <button id="route-constraints-modal-close"></button>' +
            '  <input type="checkbox" id="route-constraints-bulk-toggle" checked>' +
            '  <div id="route-constraints-bulk-inputs">' +
            '    <input type="number" id="route-constraints-bulk-alt">' +
            '    <input type="number" id="route-constraints-bulk-spd">' +
            '  </div>' +
            '  <table id="route-constraints-table"><tbody></tbody></table>' +
            '  <button id="submit-route-constraints-btn"></button>' +
            '  <button id="cancel-route-constraints-btn"></button>' +
            '</div>';
    });

    function makeManager(fakeMap: ReturnType<typeof makeFakeMap>): TestableRouteDrawingManager {
        const mapDisplay = { getMap: () => fakeMap } as unknown as MapDisplay;
        const snapper = { clearHighlight: vi.fn(), snap: () => null, highlight: vi.fn() } as unknown as NavaidSnapper;
        const app = { getRouteData: () => null } as unknown as App;
        const stateManager = {
            subscribe: vi.fn(),
            getState: () => ({ selectedAircraft: 'AC1', displayOptions: { mapLabelsTextSize: 12 } }),
            getAircraftById: () => ({ id: 'AC1', lat: 52, lon: 4 }),
        } as unknown as StateManager;
        return new TestableRouteDrawingManager(mapDisplay, app, stateManager, snapper);
    }

    it('detaches the map/keyboard handlers when the modal opens, so Enter in a modal input cannot re-open it and wipe typed constraints', () => {
        const fakeMap = makeFakeMap();
        const manager = makeManager(fakeMap);

        manager.toggleDrawing();
        manager.addPoint({ lat: 52.5, lng: 4.5 });
        expect(fakeMap.handlers.get('click')?.size).toBe(1);

        // Finish the draw via Enter -> constraints modal takes over.
        pressEnter();
        expect(fakeMap.handlers.get('click')?.size ?? 0).toBe(0);
        expect(fakeMap.handlers.get('contextmenu')?.size ?? 0).toBe(0);
        expect(fakeMap.handlers.get('mousemove')?.size ?? 0).toBe(0);

        // Type a bulk constraint, then press Enter as if confirming the
        // input. The draw's keydown handler must be gone: previously it
        // re-ran modal.show(), which cleared this very input.
        const bulkAlt = document.getElementById('route-constraints-bulk-alt') as HTMLInputElement;
        bulkAlt.value = '20000';
        pressEnter();
        expect(bulkAlt.value).toBe('20000');

        // Still drawing (state resets only on modal submit/cancel).
        expect(manager.isDrawing()).toBe(true);
    });
});
