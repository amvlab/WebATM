import { Map as MapLibreMap, MapMouseEvent, GeoJSONSource } from 'maplibre-gl';
import type { MapDisplay } from './map/MapDisplay';
import type { Console } from './Console';
import type { NavaidSnapper } from './map/NavaidSnapper';
import { logger } from '../utils/Logger';

/**
 * Context describing the geo-picking slot currently under the console cursor.
 * Produced by Console.getGeoContext() and handed to ConsoleMapPicker.enable().
 */
export interface GeoContext {
    kind: 'lat' | 'lon' | 'hdg';
    currentArgIndex: number;
    params: string[];
    parts: string[];
    command: string;
}

/**
 * ConsoleMapPicker
 *
 * Lets the console command input pull coordinates (and headings) from map
 * clicks. The Console owns the input buffer and argument-position detection;
 * this class owns the map-side state: click/mousemove handlers, cursor style,
 * guide line source/layer, and an inline hint element.
 *
 * The picker is idempotent: calling enable() repeatedly with the same kind is
 * a no-op beyond updating the stored context. disable() cleans up all map
 * resources and can be called multiple times safely.
 */
export class ConsoleMapPicker {
    private mapDisplay: MapDisplay;
    private consoleInstance: Console;
    private navaidSnapper: NavaidSnapper;

    private active: 'lat' | 'lon' | 'hdg' | null = null;
    private currentContext: GeoContext | null = null;

    private clickHandler: ((e: MapMouseEvent) => void) | null = null;
    private mouseMoveHandler: ((e: MapMouseEvent) => void) | null = null;
    // Highlights the navaid a coordinate pick would snap to (lat/lon kinds).
    private snapHoverHandler: ((e: MapMouseEvent) => void) | null = null;

    // POLY-family only: right-click on the map finishes the drawing
    // (submits the current input), Escape cancels (clears the input).
    // Mirrors ShapeDrawingManager's right-click/Esc UX.
    private polyContextHandler: ((e: MapMouseEvent) => void) | null = null;
    private polyEscapeHandler: ((e: KeyboardEvent) => void) | null = null;

    private hintElement: HTMLDivElement | null = null;

    private readonly GUIDE_SOURCE_ID = 'console-picker-hdg-guide';
    private readonly GUIDE_LAYER_ID = 'console-picker-hdg-guide-layer';
    private readonly MARKER_SOURCE_ID = 'console-picker-hdg-pos';
    private readonly MARKER_LAYER_ID = 'console-picker-hdg-pos-layer';

    // POLY-family preview (confirmed vertex line, vertex markers, and a live
    // segment from the last vertex to the mouse cursor).
    private readonly POLY_LINE_SOURCE_ID = 'console-picker-poly-line';
    private readonly POLY_LINE_LAYER_ID = 'console-picker-poly-line-layer';
    private readonly POLY_PREVIEW_SOURCE_ID = 'console-picker-poly-preview';
    private readonly POLY_PREVIEW_LAYER_ID = 'console-picker-poly-preview-layer';
    private readonly POLY_VERTEX_SOURCE_ID = 'console-picker-poly-vertex';
    private readonly POLY_VERTEX_LAYER_ID = 'console-picker-poly-vertex-layer';
    private readonly POLY_FAMILY = new Set(['POLY', 'POLYALT', 'POLYLINE']);

    constructor(mapDisplay: MapDisplay, consoleInstance: Console, navaidSnapper: NavaidSnapper) {
        this.mapDisplay = mapDisplay;
        this.consoleInstance = consoleInstance;
        this.navaidSnapper = navaidSnapper;
    }

    /**
     * Enter (or update) pick mode for the given context. Safe to call on every
     * input event: if the picker is already active for this kind, only the
     * context is refreshed and no handlers are rebound.
     */
    public enable(ctx: GeoContext): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        // Fast path: same kind, just refresh context (e.g. user kept typing
        // other parts of the same argument).
        if (this.active === ctx.kind) {
            this.currentContext = ctx;
            // Guide line / marker origin may have changed if the user edited
            // the lat/lon tokens earlier in the command - rebuild accordingly.
            if (ctx.kind === 'hdg') {
                this.ensureHeadingMouseMove(map);
                this.ensurePositionMarker(map);
            } else {
                this.removeHeadingGuide(map);
                this.removePositionMarker(map);
                this.ensurePolyOverlay(map);
                if (this.POLY_FAMILY.has(ctx.command)) {
                    this.bindPolyFinishHandlers(map);
                }
                this.bindSnapHover(map);
            }
            return;
        }

        // Kind changed (or first enable): fully refresh the mode.
        this.disable();

        this.active = ctx.kind;
        this.currentContext = ctx;

        // Bind click handler once.
        this.clickHandler = (e: MapMouseEvent) => this.handleClick(e);
        map.on('click', this.clickHandler);

        // Crosshair cursor to signal pick mode is live.
        const canvas = map.getCanvas();
        if (canvas) canvas.style.cursor = 'crosshair';

        // Show the hint text next to the console input.
        this.showHint(ctx.kind);

        // Heading picking additionally draws a dashed guide line from the
        // already-typed lat/lon to the mouse cursor, plus a red marker at the
        // origin so the user can see where the aircraft will spawn. Gated to
        // CRE by Console.getGeoContext().
        if (ctx.kind === 'hdg') {
            this.ensureHeadingMouseMove(map);
            this.ensurePositionMarker(map);
        } else {
            // POLY/POLYALT/POLYLINE: render confirmed vertices, the line
            // through them, and a live preview segment from the last vertex
            // to the mouse. No-op for any non-POLY command.
            this.ensurePolyOverlay(map);
            // For POLY-family also wire right-click (finish) and Escape
            // (cancel), matching the ShapeDrawingManager UX.
            if (this.POLY_FAMILY.has(ctx.command)) {
                this.bindPolyFinishHandlers(map);
            }
            // Highlight the navaid a click would snap to (lat/lon picks).
            this.bindSnapHover(map);
        }

        logger.debug('ConsoleMapPicker', `Enabled for ${ctx.kind}`);
    }

    /**
     * Bind right-click (finish) and Escape (cancel) for POLY-family
     * picking. Both handlers route through the Console so the input/UI
     * cleanup matches the Enter-key path. Idempotent.
     */
    private bindPolyFinishHandlers(map: MapLibreMap): void {
        if (!this.polyContextHandler) {
            this.polyContextHandler = (e: MapMouseEvent) => {
                e.preventDefault();
                this.consoleInstance.submitCurrent();
            };
            map.on('contextmenu', this.polyContextHandler);
        }
        if (!this.polyEscapeHandler) {
            // Capture phase so we run before the console input's own
            // Escape handler and can stopPropagation to prevent it from
            // firing redundant cleanup.
            this.polyEscapeHandler = (e: KeyboardEvent) => {
                if (e.key !== 'Escape') return;
                e.preventDefault();
                e.stopPropagation();
                this.consoleInstance.clearInput();
            };
            document.addEventListener(
                'keydown',
                this.polyEscapeHandler,
                true
            );
        }
    }

    /**
     * Bind a mousemove that highlights the navaid a coordinate click would
     * snap to. Idempotent; runs alongside any POLY preview mousemove.
     */
    private bindSnapHover(map: MapLibreMap): void {
        if (this.snapHoverHandler) return;
        this.snapHoverHandler = (e: MapMouseEvent) => this.navaidSnapper.highlight(e);
        map.on('mousemove', this.snapHoverHandler);
    }

    /**
     * Exit pick mode and clean up all map resources. Idempotent.
     */
    public disable(): void {
        const map = this.mapDisplay.getMap();

        if (map) {
            if (this.clickHandler) {
                map.off('click', this.clickHandler);
            }
            if (this.mouseMoveHandler) {
                map.off('mousemove', this.mouseMoveHandler);
            }
            if (this.snapHoverHandler) {
                map.off('mousemove', this.snapHoverHandler);
            }
            this.navaidSnapper.clearHighlight();

            // Restore default cursor only if we had set crosshair.
            if (this.active !== null) {
                const canvas = map.getCanvas();
                if (canvas) canvas.style.cursor = '';
            }

            this.removeHeadingGuide(map);
            this.removePositionMarker(map);
            this.removePolyOverlay(map);

            if (this.polyContextHandler) {
                map.off('contextmenu', this.polyContextHandler);
            }
        }

        if (this.polyEscapeHandler) {
            document.removeEventListener(
                'keydown',
                this.polyEscapeHandler,
                true
            );
        }

        this.clickHandler = null;
        this.mouseMoveHandler = null;
        this.snapHoverHandler = null;
        this.polyContextHandler = null;
        this.polyEscapeHandler = null;

        this.hideHint();

        if (this.active !== null) {
            logger.debug('ConsoleMapPicker', `Disabled (was ${this.active})`);
        }
        this.active = null;
        this.currentContext = null;
    }

    /**
     * Bind or rebind the mousemove handler for heading picking. Only attaches
     * if a valid origin lat/lon can be parsed from the current context.
     */
    private ensureHeadingMouseMove(map: MapLibreMap): void {
        const origin = this.resolveHdgOrigin();

        // Remove any existing handler/guide so we can rebuild cleanly.
        if (this.mouseMoveHandler) {
            map.off('mousemove', this.mouseMoveHandler);
            this.mouseMoveHandler = null;
        }
        this.removeHeadingGuide(map);

        if (!origin) {
            return;
        }

        this.mouseMoveHandler = (e: MapMouseEvent) =>
            this.handleHeadingMouseMove(e, origin.lat, origin.lon);
        map.on('mousemove', this.mouseMoveHandler);
    }

    /**
     * Walk the current context's argument list backwards from the hdg slot
     * to find the nearest lat/lon pair. Returns null if either value is
     * missing or unparseable.
     */
    private resolveHdgOrigin(): { lat: number; lon: number } | null {
        const ctx = this.currentContext;
        if (!ctx || ctx.kind !== 'hdg') return null;

        let lat: number | null = null;
        let lon: number | null = null;

        for (let i = ctx.currentArgIndex - 1; i >= 0; i--) {
            const param = ctx.params[i];
            // parts[0] is the command token, so arg i lives at parts[i + 1].
            const raw = ctx.parts[i + 1];
            if (raw === undefined) continue;
            const n = parseFloat(raw);
            if (!Number.isFinite(n)) continue;

            if (param === 'lat' && lat === null) lat = n;
            else if (param === 'lon' && lon === null) lon = n;

            if (lat !== null && lon !== null) break;
        }

        if (lat === null || lon === null) return null;
        return { lat, lon };
    }

    /**
     * Handle a map click. Dispatches into insertGeoValue on the Console with
     * the formatted value for the current pick kind.
     */
    private handleClick(e: MapMouseEvent): void {
        const ctx = this.currentContext;
        if (!ctx) return;

        // Defensively stop the canvas from stealing focus on click so we can
        // synchronously return focus to the console input.
        if (e.originalEvent) e.originalEvent.preventDefault();

        // Snap coordinate picks to a nearby navaid when enabled. Heading picks
        // set a bearing, not a place, so they are never snapped.
        let clickLat = e.lngLat.lat;
        let clickLon = e.lngLat.lng;
        if (ctx.kind === 'lat' || ctx.kind === 'lon') {
            const snapped = this.navaidSnapper.snap(e);
            if (snapped) {
                clickLat = snapped.lat;
                clickLon = snapped.lng;
            }
        }

        if (ctx.kind === 'lat' || ctx.kind === 'lon') {
            // Insert the full lat,lon pair at the *current* cursor slot,
            // not the first lat/lon in params. That way commands with
            // repeating pairs (POLY foo,lat,lon,lat,lon,...) write a new
            // pair at the cursor instead of always overwriting the first.
            const latIdx =
                ctx.kind === 'lat'
                    ? ctx.currentArgIndex
                    : ctx.currentArgIndex - 1;
            const lonIdx = latIdx + 1;

            if (
                latIdx >= 0 &&
                ctx.params[latIdx] === 'lat' &&
                ctx.params[lonIdx] === 'lon'
            ) {
                const value = `${clickLat.toFixed(6)},${clickLon.toFixed(6)}`;
                this.consoleInstance.insertGeoValue(value, latIdx, 2);
                return;
            }

            // Non-standard layout (no paired lat/lon at the cursor) - insert
            // just the current-kind coord at its slot.
            const coord =
                ctx.kind === 'lat'
                    ? clickLat.toFixed(6)
                    : clickLon.toFixed(6);
            this.consoleInstance.insertGeoValue(
                coord,
                ctx.currentArgIndex,
                1
            );
            return;
        }

        if (ctx.kind === 'hdg') {
            const origin = this.resolveHdgOrigin();
            if (!origin) {
                logger.info(
                    'ConsoleMapPicker',
                    'No prior lat,lon in command - type coordinates first'
                );
                return;
            }
            const brng = this.computeBearing(
                origin.lat,
                origin.lon,
                clickLat,
                clickLon
            );
            this.consoleInstance.insertGeoValue(
                Math.round(brng).toString(),
                ctx.currentArgIndex,
                1
            );
            return;
        }
    }

    /**
     * Update the heading guide line as the mouse moves across the map.
     */
    private handleHeadingMouseMove(
        e: MapMouseEvent,
        originLat: number,
        originLon: number
    ): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const data = {
            type: 'FeatureCollection' as const,
            features: [
                {
                    type: 'Feature' as const,
                    geometry: {
                        type: 'LineString' as const,
                        coordinates: [
                            [originLon, originLat],
                            [e.lngLat.lng, e.lngLat.lat]
                        ]
                    },
                    properties: {}
                }
            ]
        };

        const existing = map.getSource(this.GUIDE_SOURCE_ID) as
            | GeoJSONSource
            | undefined;

        if (existing) {
            existing.setData(data);
        } else {
            map.addSource(this.GUIDE_SOURCE_ID, {
                type: 'geojson',
                data
            });
            map.addLayer({
                id: this.GUIDE_LAYER_ID,
                type: 'line',
                source: this.GUIDE_SOURCE_ID,
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                paint: {
                    'line-color': '#ff6600',
                    'line-width': 2,
                    'line-dasharray': [3, 3],
                    'line-opacity': 0.8
                }
            });
        }

        // Live heading readout in the hint while moving.
        const brng = this.computeBearing(
            originLat,
            originLon,
            e.lngLat.lat,
            e.lngLat.lng
        );
        this.updateHintText(`Heading: ${Math.round(brng)}°  (click to set)`);
    }

    /**
     * Aviation bearing from (lat1, lon1) to (lat2, lon2). 0° = North,
     * clockwise. Returns a value in [0, 360).
     */
    private computeBearing(
        lat1: number,
        lon1: number,
        lat2: number,
        lon2: number
    ): number {
        const toRad = (d: number) => (d * Math.PI) / 180;
        const phi1 = toRad(lat1);
        const phi2 = toRad(lat2);
        const dLon = toRad(lon2 - lon1);

        const y = Math.sin(dLon) * Math.cos(phi2);
        const x =
            Math.cos(phi1) * Math.sin(phi2) -
            Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);

        return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    }

    /**
     * Remove the heading guide layer+source if present.
     */
    private removeHeadingGuide(map: MapLibreMap): void {
        if (map.getLayer(this.GUIDE_LAYER_ID)) {
            map.removeLayer(this.GUIDE_LAYER_ID);
        }
        if (map.getSource(this.GUIDE_SOURCE_ID)) {
            map.removeSource(this.GUIDE_SOURCE_ID);
        }
    }

    /**
     * Draw a red circle at the resolved origin lat/lon so the user sees
     * where the aircraft will spawn while they're picking the heading.
     * Mirrors the orange marker used by the Draw Aircraft dialog.
     * Only called when kind === 'hdg', which Console.getGeoContext() gates
     * to CRE.
     */
    private ensurePositionMarker(map: MapLibreMap): void {
        this.removePositionMarker(map);

        const origin = this.resolveHdgOrigin();
        if (!origin) return;

        map.addSource(this.MARKER_SOURCE_ID, {
            type: 'geojson',
            data: {
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [origin.lon, origin.lat]
                },
                properties: {}
            }
        });
        map.addLayer({
            id: this.MARKER_LAYER_ID,
            type: 'circle',
            source: this.MARKER_SOURCE_ID,
            paint: {
                'circle-radius': 8,
                'circle-color': '#ff0000',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#ffffff'
            }
        });
    }

    /**
     * Remove the origin position marker if present.
     */
    private removePositionMarker(map: MapLibreMap): void {
        if (map.getLayer(this.MARKER_LAYER_ID)) {
            map.removeLayer(this.MARKER_LAYER_ID);
        }
        if (map.getSource(this.MARKER_SOURCE_ID)) {
            map.removeSource(this.MARKER_SOURCE_ID);
        }
    }

    /**
     * Walk the current command's tokens for completed lat/lon pairs and
     * return them as `[lon, lat]` GeoJSON coordinates. Pairs are recognised
     * by the params list flagging the `lat` slot followed by a `lon` slot
     * (which `Console.getGeoContext` extends synthetically for variadic
     * POLY-family signatures).
     */
    private resolveVertices(): Array<[number, number]> {
        const ctx = this.currentContext;
        if (!ctx) return [];
        const verts: Array<[number, number]> = [];
        for (let i = 0; i < ctx.params.length - 1; i++) {
            if (ctx.params[i] !== 'lat' || ctx.params[i + 1] !== 'lon') continue;
            // parts[0] is the command token, so arg i lives at parts[i + 1].
            const latRaw = ctx.parts[i + 1];
            const lonRaw = ctx.parts[i + 2];
            if (latRaw === undefined || lonRaw === undefined) break;
            const lat = parseFloat(latRaw);
            const lon = parseFloat(lonRaw);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) break;
            verts.push([lon, lat]);
            i++; // advance past the lon slot
        }
        return verts;
    }

    /**
     * Render (or update) the polygon-preview overlay: confirmed vertex
     * markers, the line through them, and a live segment from the last
     * vertex to the mouse cursor. POLY/POLYALT close back to the first
     * vertex; POLYLINE stays open. No-op for non-POLY commands.
     */
    private ensurePolyOverlay(map: MapLibreMap): void {
        const ctx = this.currentContext;
        if (!ctx || !this.POLY_FAMILY.has(ctx.command)) {
            this.removePolyOverlay(map);
            return;
        }

        const verts = this.resolveVertices();
        const isClosed = ctx.command !== 'POLYLINE';

        // Confirmed-vertex line. POLY/POLYALT close back to the first
        // vertex once we have at least 3 corners; otherwise just connect
        // the points we have.
        const lineCoords =
            isClosed && verts.length >= 3 ? [...verts, verts[0]] : [...verts];
        this.upsertLineSource(
            map,
            this.POLY_LINE_SOURCE_ID,
            this.POLY_LINE_LAYER_ID,
            lineCoords,
            { color: '#66BB6A', dashed: false }
        );

        // Vertex markers
        this.upsertVertexMarkers(map, verts);

        // Bind/refresh mousemove for the preview segment. With no vertices
        // there's nothing to anchor a preview from, so skip it.
        if (this.mouseMoveHandler) {
            map.off('mousemove', this.mouseMoveHandler);
            this.mouseMoveHandler = null;
        }
        // Refresh the on-map banner to reflect the new vertex count.
        this.updateDrawingBanner();

        if (verts.length === 0) {
            this.removePreviewLine(map);
            return;
        }
        this.mouseMoveHandler = (e: MapMouseEvent) =>
            this.handlePolyMouseMove(e);
        map.on('mousemove', this.mouseMoveHandler);
    }

    /**
     * Mousemove handler for POLY-family preview: draw a dashed segment from
     * the last placed vertex to the cursor, plus (for closed polygons with
     * >=2 vertices) a closing segment back to the first vertex so the user
     * sees the polygon they're about to make.
     */
    private handlePolyMouseMove(e: MapMouseEvent): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;
        const ctx = this.currentContext;
        if (!ctx) return;

        const verts = this.resolveVertices();
        if (verts.length === 0) return;

        const cursor: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        const last = verts[verts.length - 1];
        const isClosed = ctx.command !== 'POLYLINE';

        const previewCoords: Array<[number, number]> = [last, cursor];
        if (isClosed && verts.length >= 2) {
            previewCoords.push(verts[0]);
        }

        this.upsertLineSource(
            map,
            this.POLY_PREVIEW_SOURCE_ID,
            this.POLY_PREVIEW_LAYER_ID,
            previewCoords,
            { color: '#ff6600', dashed: true }
        );
    }

    /**
     * Upsert a GeoJSON line source/layer. Reused by the confirmed-vertex
     * line and the preview line.
     */
    private upsertLineSource(
        map: MapLibreMap,
        sourceId: string,
        layerId: string,
        coords: Array<[number, number]>,
        style: { color: string; dashed: boolean }
    ): void {
        const data = {
            type: 'Feature' as const,
            geometry: {
                type: 'LineString' as const,
                coordinates: coords
            },
            properties: {}
        };

        const existing = map.getSource(sourceId) as GeoJSONSource | undefined;
        if (existing) {
            existing.setData(data);
            return;
        }

        map.addSource(sourceId, { type: 'geojson', data });
        map.addLayer({
            id: layerId,
            type: 'line',
            source: sourceId,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': style.color,
                'line-width': 2,
                'line-opacity': 0.9,
                ...(style.dashed ? { 'line-dasharray': [3, 3] } : {})
            }
        });
    }

    /**
     * Upsert a circle layer with one feature per vertex.
     */
    private upsertVertexMarkers(
        map: MapLibreMap,
        verts: Array<[number, number]>
    ): void {
        const data = {
            type: 'FeatureCollection' as const,
            features: verts.map(v => ({
                type: 'Feature' as const,
                geometry: { type: 'Point' as const, coordinates: v },
                properties: {}
            }))
        };

        const existing = map.getSource(this.POLY_VERTEX_SOURCE_ID) as
            | GeoJSONSource
            | undefined;
        if (existing) {
            existing.setData(data);
            return;
        }

        map.addSource(this.POLY_VERTEX_SOURCE_ID, {
            type: 'geojson',
            data
        });
        map.addLayer({
            id: this.POLY_VERTEX_LAYER_ID,
            type: 'circle',
            source: this.POLY_VERTEX_SOURCE_ID,
            paint: {
                'circle-radius': 5,
                'circle-color': '#66BB6A',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#ffffff'
            }
        });
    }

    /** Tear down all POLY-overlay layers and sources. Idempotent. */
    private removePolyOverlay(map: MapLibreMap): void {
        this.removePreviewLine(map);
        if (map.getLayer(this.POLY_LINE_LAYER_ID)) {
            map.removeLayer(this.POLY_LINE_LAYER_ID);
        }
        if (map.getSource(this.POLY_LINE_SOURCE_ID)) {
            map.removeSource(this.POLY_LINE_SOURCE_ID);
        }
        if (map.getLayer(this.POLY_VERTEX_LAYER_ID)) {
            map.removeLayer(this.POLY_VERTEX_LAYER_ID);
        }
        if (map.getSource(this.POLY_VERTEX_SOURCE_ID)) {
            map.removeSource(this.POLY_VERTEX_SOURCE_ID);
        }
    }

    /** Tear down just the preview segment (used between mousemove updates). */
    private removePreviewLine(map: MapLibreMap): void {
        if (map.getLayer(this.POLY_PREVIEW_LAYER_ID)) {
            map.removeLayer(this.POLY_PREVIEW_LAYER_ID);
        }
        if (map.getSource(this.POLY_PREVIEW_SOURCE_ID)) {
            map.removeSource(this.POLY_PREVIEW_SOURCE_ID);
        }
    }

    /**
     * Create (if needed) and show the inline hint element next to the console
     * input. The hint is reused across pick sessions.
     */
    private showHint(kind: 'lat' | 'lon' | 'hdg'): void {
        const isPoly =
            this.currentContext !== null &&
            this.POLY_FAMILY.has(this.currentContext.command);

        // POLY-family uses the on-map drawing banner instead of the small
        // inline hint, matching the Draw-Shape-from-dialog UX.
        if (isPoly) {
            this.hideInlineHint();
            this.updateDrawingBanner();
            return;
        }

        if (!this.hintElement) {
            const container = document.querySelector(
                '.console-input-container'
            );
            if (!container) return;
            this.hintElement = document.createElement('div');
            this.hintElement.className = 'console-map-pick-hint';
            container.appendChild(this.hintElement);
        }
        const text =
            kind === 'hdg'
                ? 'Click map for heading'
                : kind === 'lat'
                ? 'Click map for lat,lon'
                : 'Click map for lon';
        this.hintElement.textContent = text;
        this.hintElement.style.display = 'block';
    }

    /**
     * Render the on-map "Drawing ... N point(s) (Right-click to finish,
     * Esc to cancel)" banner used by POLY-family picking. Reuses the same
     * #drawing-banner element ShapeDrawingManager populates so the visual
     * style matches the dialog-driven flow.
     */
    private updateDrawingBanner(): void {
        const banner = document.getElementById('drawing-banner');
        const bannerText = document.getElementById('drawing-banner-text');
        if (!banner || !bannerText) return;

        const ctx = this.currentContext;
        if (!ctx || !this.POLY_FAMILY.has(ctx.command)) {
            banner.style.display = 'none';
            return;
        }

        const verts = this.resolveVertices();
        // First arg after the command token is the shape name.
        const name = ctx.parts[1] ?? '';
        const namePart = name ? ` "${name}"` : '';
        bannerText.textContent =
            `Drawing ${ctx.command}${namePart} - ${verts.length} point(s) ` +
            `(Right-click to finish, Esc to cancel)`;
        banner.style.display = 'flex';
    }

    private hideDrawingBanner(): void {
        const banner = document.getElementById('drawing-banner');
        if (banner) banner.style.display = 'none';
    }

    private hideInlineHint(): void {
        if (this.hintElement) this.hintElement.style.display = 'none';
    }

    private updateHintText(text: string): void {
        if (this.hintElement) this.hintElement.textContent = text;
    }

    private hideHint(): void {
        this.hideInlineHint();
        this.hideDrawingBanner();
    }
}
