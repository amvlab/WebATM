import type { MapDisplay } from './MapDisplay';
import type { MapMouseEvent } from 'maplibre-gl';
import type { NavaidSnapper } from './navdata/NavaidSnapper';
import { DRAWING_CURSOR } from '../../utils/maplibre';
import { isTextEntryTarget } from '../../utils/dom';
import { claimDrawing, releaseDrawing } from './drawingExclusion';

/**
 * BaseDrawingManager - shared interactive point-drawing lifecycle for the
 * route and shape drawing managers.
 *
 * Owns the parts both managers used to duplicate:
 * - drawing-mode flag and isDrawing()
 * - map event wiring/teardown (click, right-click, mousemove, keydown)
 *   with crosshair cursor management
 * - navaid snapping on click and hover highlight on mousemove
 * - the shared drawing banner
 * - key handling: Esc cancels, Enter optionally finishes (finishOnEnter)
 *
 * Subclasses implement the hooks for their own preview layers, point
 * bookkeeping, and command generation.
 */
export interface DrawingPoint {
    lat: number;
    lng: number;
}

export abstract class BaseDrawingManager {
    protected drawingMode: boolean = false;

    // Event handler refs for clean teardown
    private mapClickHandler: ((e: MapMouseEvent) => void) | null = null;
    private mapRightClickHandler: ((e: MapMouseEvent) => void) | null = null;
    private mapMouseMoveHandler: ((e: MapMouseEvent) => void) | null = null;
    private keyDownHandler: ((e: KeyboardEvent) => void) | null = null;

    // Aborted in destroy(); subclasses register any long-lived document or
    // window listeners with this signal so app teardown removes them.
    private readonly teardownAbort = new AbortController();

    protected get teardownSignal(): AbortSignal {
        return this.teardownAbort.signal;
    }

    /** When true, the Enter key finishes the draw (in addition to right-click). */
    protected readonly finishOnEnter: boolean = false;

    constructor(
        protected mapDisplay: MapDisplay,
        protected navaidSnapper: NavaidSnapper
    ) {}

    /**
     * Whether interactive drawing is currently active. Consumed by
     * AircraftInteractionManager to suppress empty-map-click behavior.
     */
    public isDrawing(): boolean {
        return this.drawingMode;
    }

    /** Toggle drawing on/off; entry point for the panel buttons. */
    public abstract toggleDrawing(): void;

    /**
     * Cancel any in-progress draw and release long-lived listeners.
     * Called from App.cleanup() at page teardown.
     */
    public destroy(): void {
        if (this.drawingMode) {
            this.cancelDrawing();
        }
        this.teardownAbort.abort();
    }

    /** Set up preview sources/layers when drawing starts. */
    protected abstract onDrawingEnabled(): void;

    /** Clear/remove preview sources/layers when drawing stops. */
    protected abstract onDrawingDisabled(): void;

    /** A point was placed (already navaid-snapped when applicable). */
    protected abstract onPointAdded(point: DrawingPoint): void;

    /** The cursor moved while drawing (navaid highlight already applied). */
    protected abstract onCursorMove(point: DrawingPoint): void;

    /** Finish the draw (right-click, or Enter when finishOnEnter). */
    protected abstract finishDrawing(): void | Promise<void>;

    /** Cancel the draw (Escape). */
    protected abstract cancelDrawing(): void;

    /**
     * Switch the map into drawing mode: crosshair cursor, subclass preview
     * setup, and tracked event handlers.
     */
    protected enableMapDrawing(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        // Cancel any other tool's in-progress draw (shape vs route vs
        // aircraft placement) so two tools never consume the same clicks.
        claimDrawing(this, () => this.cancelDrawing());

        map.getCanvas().style.cursor = DRAWING_CURSOR;

        this.onDrawingEnabled();

        this.mapClickHandler = this.onMapClick.bind(this);
        this.mapRightClickHandler = this.onMapRightClick.bind(this);
        this.mapMouseMoveHandler = this.onMapMouseMove.bind(this);
        this.keyDownHandler = this.onKeyDown.bind(this);

        map.on('click', this.mapClickHandler);
        map.on('contextmenu', this.mapRightClickHandler);
        map.on('mousemove', this.mapMouseMoveHandler);
        document.addEventListener('keydown', this.keyDownHandler);
    }

    /**
     * Restore the map to normal mode and tear down all drawing handlers.
     */
    protected disableMapDrawing(): void {
        this.suspendMapInteraction();
        this.onDrawingDisabled();
        releaseDrawing(this);
    }

    /**
     * Detach the drawing event handlers (map clicks, mousemove, keydown) and
     * restore the cursor, while leaving the preview layers up. Used when a
     * follow-up dialog takes over the interaction - so its keystrokes and
     * clicks can't re-trigger the draw - and by disableMapDrawing().
     * Idempotent.
     */
    protected suspendMapInteraction(): void {
        // The map can already be gone at teardown; the document-level keydown
        // listener and the navaid highlight must be released regardless.
        const map = this.mapDisplay.getMap();
        if (map) {
            map.getCanvas().style.cursor = '';
            if (this.mapClickHandler) map.off('click', this.mapClickHandler);
            if (this.mapRightClickHandler) map.off('contextmenu', this.mapRightClickHandler);
            if (this.mapMouseMoveHandler) map.off('mousemove', this.mapMouseMoveHandler);
        }
        this.mapClickHandler = null;
        this.mapRightClickHandler = null;
        this.mapMouseMoveHandler = null;

        if (this.keyDownHandler) {
            document.removeEventListener('keydown', this.keyDownHandler);
            this.keyDownHandler = null;
        }

        this.navaidSnapper.clearHighlight();
    }

    private onMapClick(e: MapMouseEvent): void {
        if (!this.drawingMode) return;

        // Snap to a nearby navaid when enabled, else use the raw click.
        const snapped = this.navaidSnapper.snap(e);
        const point = snapped
            ? { lat: snapped.lat, lng: snapped.lng }
            : { lat: e.lngLat.lat, lng: e.lngLat.lng };

        this.onPointAdded(point);
    }

    private onMapRightClick(e: MapMouseEvent): void {
        e.preventDefault(); // Prevent context menu
        if (!this.drawingMode) return;
        this.finishDrawing();
    }

    private onMapMouseMove(e: MapMouseEvent): void {
        if (!this.drawingMode) return;

        // Highlight the navaid the next click would snap to.
        this.navaidSnapper.highlight(e);
        this.onCursorMove({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    }

    private onKeyDown(e: KeyboardEvent): void {
        // Leave keystrokes aimed at a focused text field (e.g. the console)
        // alone: Enter there sends the command, not "finish the draw".
        if (!this.drawingMode || isTextEntryTarget(e.target)) return;

        if (e.key === 'Escape') {
            e.preventDefault();
            this.cancelDrawing();
        } else if (e.key === 'Enter' && this.finishOnEnter) {
            e.preventDefault();
            this.finishDrawing();
        }
    }

    /**
     * Show the shared drawing banner with a message.
     */
    protected showDrawingBanner(message: string): void {
        const banner = document.getElementById('drawing-banner');
        const bannerText = document.getElementById('drawing-banner-text');
        if (banner && bannerText) {
            bannerText.textContent = message;
            banner.style.display = 'flex';
        }
    }

    protected hideDrawingBanner(): void {
        const banner = document.getElementById('drawing-banner');
        if (banner) {
            banner.style.display = 'none';
        }
    }
}
