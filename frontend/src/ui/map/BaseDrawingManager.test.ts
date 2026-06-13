// @vitest-environment happy-dom
/**
 * Tests for the shared drawing lifecycle extracted from the route and
 * shape drawing managers: event wiring/teardown, navaid snapping, and
 * Escape/Enter key handling.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BaseDrawingManager, DrawingPoint } from './BaseDrawingManager';
import type { MapDisplay } from './MapDisplay';
import type { NavaidSnapper } from './navdata/NavaidSnapper';
import type { MapMouseEvent } from 'maplibre-gl';

function createFakeMap() {
    const handlers: Record<string, Array<(e: unknown) => void>> = {};
    const canvas = { style: { cursor: '' } };
    return {
        handlers,
        canvas,
        on: vi.fn((event: string, handler: (e: unknown) => void) => {
            (handlers[event] ??= []).push(handler);
        }),
        off: vi.fn((event: string, handler: (e: unknown) => void) => {
            handlers[event] = (handlers[event] ?? []).filter(h => h !== handler);
        }),
        getCanvas: () => canvas,
        fire(event: string, e: unknown) {
            (handlers[event] ?? []).forEach(h => h(e));
        },
    };
}

class TestDrawingManager extends BaseDrawingManager {
    public points: DrawingPoint[] = [];
    public cursorMoves: DrawingPoint[] = [];
    public enabled = vi.fn();
    public disabled = vi.fn();
    public finished = vi.fn();
    public cancelled = vi.fn();
    protected override readonly finishOnEnter: boolean;

    constructor(mapDisplay: MapDisplay, snapper: NavaidSnapper, finishOnEnter: boolean) {
        super(mapDisplay, snapper);
        this.finishOnEnter = finishOnEnter;
    }

    public toggleDrawing(): void {}
    public start(): void {
        this.drawingMode = true;
        this.enableMapDrawing();
    }
    public stop(): void {
        this.drawingMode = false;
        this.disableMapDrawing();
    }
    protected onDrawingEnabled(): void { this.enabled(); }
    protected onDrawingDisabled(): void { this.disabled(); }
    protected onPointAdded(point: DrawingPoint): void { this.points.push(point); }
    protected onCursorMove(point: DrawingPoint): void { this.cursorMoves.push(point); }
    protected finishDrawing(): void { this.finished(); }
    protected cancelDrawing(): void { this.cancelled(); }
}

describe('BaseDrawingManager', () => {
    let map: ReturnType<typeof createFakeMap>;
    let snapper: { snap: ReturnType<typeof vi.fn>; highlight: ReturnType<typeof vi.fn>; clearHighlight: ReturnType<typeof vi.fn> };
    let manager: TestDrawingManager;

    const clickEvent = (lat: number, lng: number) =>
        ({ lngLat: { lat, lng }, preventDefault: vi.fn() }) as unknown as MapMouseEvent;

    function createManager(finishOnEnter = false): TestDrawingManager {
        map = createFakeMap();
        snapper = { snap: vi.fn(() => null), highlight: vi.fn(), clearHighlight: vi.fn() };
        const mapDisplay = { getMap: () => map } as unknown as MapDisplay;
        return new TestDrawingManager(mapDisplay, snapper as unknown as NavaidSnapper, finishOnEnter);
    }

    beforeEach(() => {
        manager = createManager();
    });

    it('enableMapDrawing sets the crosshair cursor, calls the hook, and wires handlers', () => {
        manager.start();
        expect(map.canvas.style.cursor).toBe('crosshair');
        expect(manager.enabled).toHaveBeenCalledTimes(1);
        expect(map.on).toHaveBeenCalledTimes(3);
        expect(manager.isDrawing()).toBe(true);
    });

    it('disableMapDrawing resets the cursor, removes handlers, and clears the navaid highlight', () => {
        manager.start();
        manager.stop();
        expect(map.canvas.style.cursor).toBe('');
        expect(manager.disabled).toHaveBeenCalledTimes(1);
        expect(snapper.clearHighlight).toHaveBeenCalledTimes(1);
        map.fire('click', clickEvent(52, 4));
        expect(manager.points).toEqual([]);
    });

    it('clicks add the raw point when no navaid snap applies', () => {
        manager.start();
        map.fire('click', clickEvent(52.3, 4.8));
        expect(manager.points).toEqual([{ lat: 52.3, lng: 4.8 }]);
    });

    it('clicks add the snapped point when the snapper matches', () => {
        manager.start();
        snapper.snap.mockReturnValue({ lat: 50, lng: 5 });
        map.fire('click', clickEvent(52.3, 4.8));
        expect(manager.points).toEqual([{ lat: 50, lng: 5 }]);
    });

    it('mousemove highlights navaids and reports the cursor position', () => {
        manager.start();
        map.fire('mousemove', clickEvent(51, 3));
        expect(snapper.highlight).toHaveBeenCalledTimes(1);
        expect(manager.cursorMoves).toEqual([{ lat: 51, lng: 3 }]);
    });

    it('right-click prevents the context menu and finishes the draw', () => {
        manager.start();
        const e = clickEvent(52, 4);
        map.fire('contextmenu', e);
        expect(e.preventDefault).toHaveBeenCalled();
        expect(manager.finished).toHaveBeenCalledTimes(1);
    });

    it('Escape cancels the draw', () => {
        manager.start();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(manager.cancelled).toHaveBeenCalledTimes(1);
    });

    it('Enter finishes only when finishOnEnter is set', () => {
        manager.start();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(manager.finished).not.toHaveBeenCalled();
        manager.stop();

        const enterManager = createManager(true);
        enterManager.start();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(enterManager.finished).toHaveBeenCalledTimes(1);
    });

    it('ignores events while not in drawing mode', () => {
        manager.start();
        manager.stop();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(manager.cancelled).not.toHaveBeenCalled();
    });

    it('destroy cancels an active draw and aborts the teardown signal', () => {
        manager.start();
        manager.destroy();
        expect(manager.cancelled).toHaveBeenCalledTimes(1);

        const idle = createManager();
        idle.destroy();
        expect(idle.cancelled).not.toHaveBeenCalled();
    });
});
