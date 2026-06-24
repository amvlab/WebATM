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
