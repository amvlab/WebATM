import { GeoJSONSource, MapMouseEvent } from 'maplibre-gl';
import type { MapDisplay } from '../MapDisplay';
import type { StateManager } from '../../../core/StateManager';
import { featureCollection, pointFeature } from '../../../utils/geojson';
import { logger } from '../../../utils/Logger';

/**
 * Result of a successful snap: the navaid coordinate plus its identity so
 * callers can use the precise position (and, in future, the ICAO/ident name).
 */
export interface SnapResult {
    lng: number;
    lat: number;
    ident: string;
    kind: string;
}

/**
 * NavaidSnapper - shared helper that lets the drawing/creation tools snap a
 * clicked coordinate to the nearest visible navaid (airport, heliport or
 * waypoint).
 *
 * The navdata is a queryable MapLibre vector source (see NavdataRenderer), so we
 * just probe the rendered point layers in a small pixel box around the cursor
 * and pick the closest hit. queryRenderedFeatures already skips layers whose
 * visibility is 'none', so toggling a navaid type off in Display Options also
 * removes it as a snap target for free.
 *
 * A single instance is shared by ShapeDrawingManager, RouteDrawingManager and
 * AircraftCreationManager, and also drives a hover highlight (ring + ident
 * label) so the user can see what a click will snap to before committing.
 */
export class NavaidSnapper {
    private mapDisplay: MapDisplay;
    private stateManager: StateManager;
    // Lazily resolved (the NavdataRenderer is created after this snapper). Falls
    // back to 0 (snap to all airports) before the renderer is ready.
    private getMinAirportRank: (zoom: number) => number;

    // Cursor search radius (pixels). Querying a box rather than a single point
    // is what makes the tiny navaid dots easy to grab.
    private readonly SNAP_PX = 12;

    private readonly LAYERS = [
        'navdata-airports',
        'navdata-heliports',
        'navdata-waypoints'
    ];

    private readonly HIGHLIGHT_SOURCE = 'snap-highlight';
    private readonly HIGHLIGHT_RING_LAYER = 'snap-highlight-ring';
    private readonly HIGHLIGHT_LABEL_LAYER = 'snap-highlight-label';

    constructor(
        mapDisplay: MapDisplay,
        stateManager: StateManager,
        getMinAirportRank: (zoom: number) => number
    ) {
        this.mapDisplay = mapDisplay;
        this.stateManager = stateManager;
        this.getMinAirportRank = getMinAirportRank;
    }

    /** Whether snapping is currently enabled (Display Options toggle). */
    private isEnabled(): boolean {
        return this.stateManager.getDisplayOptions().snapToNavaids !== false;
    }

    /**
     * Find the nearest snappable navaid to the cursor, or null if snapping is
     * off or nothing is within range.
     */
    public snap(e: MapMouseEvent): SnapResult | null {
        if (!this.isEnabled()) return null;

        const map = this.mapDisplay.getMap();
        if (!map) return null;

        const layers = this.LAYERS.filter(id => map.getLayer(id));
        if (layers.length === 0) return null;

        const { x, y } = e.point;
        const bbox: [[number, number], [number, number]] = [
            [x - this.SNAP_PX, y - this.SNAP_PX],
            [x + this.SNAP_PX, y + this.SNAP_PX]
        ];

        let features;
        try {
            features = map.queryRenderedFeatures(bbox, { layers });
        } catch (err) {
            logger.debug('NavaidSnapper', 'queryRenderedFeatures failed', err);
            return null;
        }
        if (!features || features.length === 0) return null;

        const minRank = this.getMinAirportRank(map.getZoom());

        let best: SnapResult | null = null;
        let bestDist = Infinity;
        for (const f of features) {
            if (!f.geometry || f.geometry.type !== 'Point') continue;
            const props = f.properties || {};
            const kind = String(props.kind ?? '');

            // Don't snap to airports that aren't revealed at this zoom (their
            // dots are painted with opacity 0 but still returned by the query).
            if (kind === 'airport') {
                const rank = Number(props.rank ?? 0);
                if (rank < minRank) continue;
            }

            const [lng, lat] = f.geometry.coordinates as [number, number];
            const p = map.project([lng, lat]);
            const dist = Math.hypot(p.x - x, p.y - y);
            if (dist < bestDist) {
                bestDist = dist;
                best = { lng, lat, ident: String(props.ident ?? ''), kind };
            }
        }

        return best;
    }

    /**
     * Update the hover highlight to mark the navaid the cursor would snap to.
     * Shows a ring + ident label when a candidate is found, hides it otherwise.
     */
    public highlight(e: MapMouseEvent): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const candidate = this.snap(e);
        this.ensureHighlightLayers();

        const source = map.getSource(this.HIGHLIGHT_SOURCE) as GeoJSONSource | undefined;
        if (!source) return;

        if (!candidate) {
            source.setData(featureCollection());
            return;
        }

        source.setData(featureCollection([
            pointFeature([candidate.lng, candidate.lat], { ident: candidate.ident })
        ]));
    }

    /** Hide the highlight (keeps the layers around for the next hover). */
    public clearHighlight(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;
        const source = map.getSource(this.HIGHLIGHT_SOURCE) as GeoJSONSource | undefined;
        if (source) {
            source.setData(featureCollection());
        }
    }

    /** Remove highlight layers + source entirely. */
    public teardown(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;
        for (const id of [this.HIGHLIGHT_LABEL_LAYER, this.HIGHLIGHT_RING_LAYER]) {
            if (map.getLayer(id)) map.removeLayer(id);
        }
        if (map.getSource(this.HIGHLIGHT_SOURCE)) map.removeSource(this.HIGHLIGHT_SOURCE);
    }

    /**
     * Lazily create the highlight source/layers. They're transient overlays; if
     * a basemap style swap wipes them mid-draw they're recreated on the next
     * hover.
     */
    private ensureHighlightLayers(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        if (!map.getSource(this.HIGHLIGHT_SOURCE)) {
            map.addSource(this.HIGHLIGHT_SOURCE, {
                type: 'geojson',
                data: featureCollection()
            });
        }

        if (!map.getLayer(this.HIGHLIGHT_RING_LAYER)) {
            map.addLayer({
                id: this.HIGHLIGHT_RING_LAYER,
                type: 'circle',
                source: this.HIGHLIGHT_SOURCE,
                paint: {
                    'circle-radius': 9,
                    'circle-color': 'rgba(0,0,0,0)',
                    'circle-stroke-color': '#ffcc00',
                    'circle-stroke-width': 2
                }
            });
        }

        if (!map.getLayer(this.HIGHLIGHT_LABEL_LAYER)) {
            map.addLayer({
                id: this.HIGHLIGHT_LABEL_LAYER,
                type: 'symbol',
                source: this.HIGHLIGHT_SOURCE,
                layout: {
                    'text-field': ['get', 'ident'],
                    'text-font': ['Open Sans Regular'],
                    'text-size': 12,
                    'text-offset': [0, -1.2],
                    'text-anchor': 'bottom',
                    'text-allow-overlap': true,
                    'text-ignore-placement': true
                },
                paint: {
                    'text-color': '#ffcc00',
                    'text-halo-color': '#0b0f15',
                    'text-halo-width': 1.4
                }
            });
        }
    }
}
