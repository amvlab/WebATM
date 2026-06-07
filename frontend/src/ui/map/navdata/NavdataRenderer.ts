import { Map as MapLibreMap } from 'maplibre-gl';
import { DisplayOptions } from '../../../data/types';
import type { MapDisplay } from '../MapDisplay';
import type { StateManager } from '../../../core/StateManager';
import { logger } from '../../../utils/Logger';

/**
 * NavdataRenderer - renders the static airports + waypoints overlay.
 *
 * Unlike ShapeRenderer (which pushes simulation GeoJSON into geojson sources),
 * this reads a pre-built vector-tile archive produced offline from X-Plane
 * navigation data (see scripts/navdata/). The archive is served as a single
 * static PMTiles file and exposes two source-layers, "airports" and
 * "waypoints". Because the tiles load themselves, this renderer only has to
 * declare the source + layers once and toggle their visibility.
 *
 * If the archive is missing (the offline build step hasn't been run), MapLibre
 * simply emits tile-load errors that MapDisplay already suppresses, so the rest
 * of the map keeps working.
 */
export class NavdataRenderer {
    private mapDisplay: MapDisplay;
    private stateManager: StateManager;
    private initialized = false;

    private readonly SOURCE_ID = 'navdata';
    // Served statically; the pmtiles:// protocol is registered in MapDisplay.
    private readonly SOURCE_URL = 'pmtiles:///static/tiles/navdata.pmtiles';

    // Source-layer names must match the tippecanoe --layer names in
    // scripts/navdata/build_navdata_tiles.sh.
    private readonly AIRPORTS_SRC_LAYER = 'airports';
    private readonly HELIPORTS_SRC_LAYER = 'heliports';
    private readonly WAYPOINTS_SRC_LAYER = 'waypoints';
    private readonly RUNWAYS_SRC_LAYER = 'runways';
    private readonly PAVEMENT_SRC_LAYER = 'pavement';

    private readonly AIRPORTS_LAYER_ID = 'navdata-airports';
    private readonly AIRPORT_LABELS_LAYER_ID = 'navdata-airport-labels';
    private readonly HELIPORTS_LAYER_ID = 'navdata-heliports';
    private readonly HELIPORT_MARKER_LAYER_ID = 'navdata-heliport-marker';
    private readonly WAYPOINTS_LAYER_ID = 'navdata-waypoints';
    private readonly WAYPOINT_LABELS_LAYER_ID = 'navdata-waypoint-labels';
    private readonly RUNWAYS_FILL_LAYER_ID = 'navdata-runways-fill';
    private readonly RUNWAYS_LINE_LAYER_ID = 'navdata-runways-line';
    private readonly RUNWAY_LABELS_LAYER_ID = 'navdata-runway-labels';
    private readonly PAVEMENT_FILL_LAYER_ID = 'navdata-pavement-fill';

    // ----------------------------------------------------------------------
    // Zoom control for the navdata overlay - tune it all here. These drive the
    // style expressions/minzooms below, so changes take effect on rebuild with
    // no need to re-tile.
    // ----------------------------------------------------------------------

    // Lowest map zoom at which each label layer is allowed to draw.
    private readonly LABEL_MINZOOM = {
        airport: 6,
        waypoint: 9,
        runway: 13
    };

    // Airport importance gating: each [zoom, minRank] means "from this zoom,
    // show airports whose rank (0-5) is at least minRank". So less important
    // airports only appear as you zoom in. Must be ascending by zoom; the final
    // entry with minRank 0 reveals everything.
    private readonly AIRPORT_IMPORTANCE_BY_ZOOM: [number, number][] = [
        [3, 5],   // major hubs only, when zoomed far out
        [5, 4],
        [7, 3],
        [8, 2],
        [9, 1],
        [11, 0]   // everything once zoomed right in
    ];

    // Theme-aware colours for the navdata overlay. Airports use a calmer blue on
    // the dark basemap (the old #4da3ff was too bright) and a deep blue on light
    // basemaps; waypoints darken on light maps where the dark grey would wash
    // out. Halos flip so labels keep contrast against the background. Heliports
    // read fine on both, so their colour is shared. These are not surfaced as
    // user colour pickers, so the active map theme is the source of truth.
    private readonly PALETTES = {
        dark: {
            airport: '#3f7fc2',
            waypoint: '#9aa7b4',
            heliport: '#e0823c',
            halo: '#0b0f15',
            stroke: '#ffffff'
        },
        light: {
            airport: '#1565c0',
            waypoint: '#5a6470',
            heliport: '#e0823c',
            halo: '#ffffff',
            stroke: '#ffffff'
        }
    } as const;

    constructor(mapDisplay: MapDisplay, stateManager: StateManager) {
        this.mapDisplay = mapDisplay;
        this.stateManager = stateManager;
    }

    /** Palette matching the active basemap (see MapDisplay.getMapTheme). */
    private getPalette() {
        return this.PALETTES[this.mapDisplay.getMapTheme()];
    }

    /**
     * Lowest airport rank that is actually revealed at the given zoom, derived
     * from AIRPORT_IMPORTANCE_BY_ZOOM (the same thresholds that drive the
     * importance-opacity expression). Used by NavaidSnapper so snapping only
     * targets airports the user can currently see.
     */
    public minAirportRankForZoom(zoom: number): number {
        let minRank = Infinity;
        for (const [z, rank] of this.AIRPORT_IMPORTANCE_BY_ZOOM) {
            if (zoom >= z) minRank = rank;
        }
        return minRank;
    }

    /**
     * Opacity expression that reveals airports by importance as you zoom in,
     * built from AIRPORT_IMPORTANCE_BY_ZOOM. Lives in the style (not the
     * tiles), so the thresholds above can be tuned without re-tiling.
     */
    private importanceOpacity(): any {
        const expr: any[] = ['step', ['zoom'], 0];
        for (const [zoom, minRank] of this.AIRPORT_IMPORTANCE_BY_ZOOM) {
            expr.push(
                zoom,
                minRank <= 0
                    ? 1
                    : ['case', ['>=', ['coalesce', ['get', 'rank'], 0], minRank], 1, 0]
            );
        }
        return expr;
    }

    public initialize(): void {
        if (this.initialized) return;

        const map = this.mapDisplay.getMap();
        if (!map) {
            logger.warn('NavdataRenderer', 'Cannot initialize - map not available');
            return;
        }

        this.setupMapLayers(map);

        // React to visibility / colour changes from the display options panel.
        this.stateManager.subscribe('displayOptions', (newOptions) => {
            if (newOptions) {
                this.updateDisplayOptions(newOptions);
            }
        });

        this.initialized = true;
        logger.info('NavdataRenderer', 'Initialized');
    }

    private setupMapLayers(map: MapLibreMap): void {
        const opts = this.stateManager.getDisplayOptions();
        const pal = this.getPalette();
        const labelSize = opts.mapLabelsTextSize;

        if (!map.getSource(this.SOURCE_ID)) {
            map.addSource(this.SOURCE_ID, {
                type: 'vector',
                url: this.SOURCE_URL,
                attribution:
                    '<a href="https://developer.x-plane.com/docs/data-development-documentation/">X-Plane navdata</a> (GPL)'
            });
        }

        const vis = (on: boolean) => (on ? 'visible' : 'none');

        // Pavement (taxiways/aprons) at the very bottom, then runways on top.
        if (!map.getLayer(this.PAVEMENT_FILL_LAYER_ID)) {
            map.addLayer({
                id: this.PAVEMENT_FILL_LAYER_ID,
                type: 'fill',
                source: this.SOURCE_ID,
                'source-layer': this.PAVEMENT_SRC_LAYER,
                paint: {
                    'fill-color': opts.pavementColor || '#5a6470',
                    'fill-opacity': 0.5
                },
                layout: { visibility: vis(opts.showAirports && opts.showPavement) }
            });
        }

        // Runways above pavement (filled polygons), then point overlays on top.
        if (!map.getLayer(this.RUNWAYS_FILL_LAYER_ID)) {
            map.addLayer({
                id: this.RUNWAYS_FILL_LAYER_ID,
                type: 'fill',
                source: this.SOURCE_ID,
                'source-layer': this.RUNWAYS_SRC_LAYER,
                paint: {
                    'fill-color': opts.runwayColor || '#c8d2dc',
                    'fill-opacity': 0.55
                },
                layout: { visibility: vis(opts.showAirports && opts.showRunways) }
            });
        }

        if (!map.getLayer(this.RUNWAYS_LINE_LAYER_ID)) {
            map.addLayer({
                id: this.RUNWAYS_LINE_LAYER_ID,
                type: 'line',
                source: this.SOURCE_ID,
                'source-layer': this.RUNWAYS_SRC_LAYER,
                paint: {
                    'line-color': opts.runwayColor || '#c8d2dc',
                    'line-width': 0.8
                },
                layout: { visibility: vis(opts.showAirports && opts.showRunways) }
            });
        }

        // Waypoints next so airports paint on top of them.
        if (!map.getLayer(this.WAYPOINTS_LAYER_ID)) {
            map.addLayer({
                id: this.WAYPOINTS_LAYER_ID,
                type: 'circle',
                source: this.SOURCE_ID,
                'source-layer': this.WAYPOINTS_SRC_LAYER,
                paint: {
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 1.5, 11, 3],
                    'circle-color': pal.waypoint,
                    'circle-opacity': 0.8
                },
                layout: { visibility: vis(opts.showWaypoints && opts.showWaypointIcons) }
            });
        }

        if (!map.getLayer(this.WAYPOINT_LABELS_LAYER_ID)) {
            map.addLayer({
                id: this.WAYPOINT_LABELS_LAYER_ID,
                type: 'symbol',
                source: this.SOURCE_ID,
                'source-layer': this.WAYPOINTS_SRC_LAYER,
                minzoom: this.LABEL_MINZOOM.waypoint,
                layout: {
                    'text-field': ['get', 'ident'],
                    // Single explicit fontstack: served by the remote basemaps
                    // and the one glyph folder we self-host for offline mode.
                    'text-font': ['Open Sans Regular'],
                    // Tied to the "Map Labels Size" slider; kept one step below
                    // airport labels to preserve the existing size hierarchy.
                    'text-size': Math.max(1, labelSize - 1),
                    'text-offset': [0, 0.8],
                    'text-anchor': 'top',
                    'text-allow-overlap': false,
                    visibility: vis(opts.showWaypoints && opts.showWaypointLabels)
                },
                paint: {
                    'text-color': pal.waypoint,
                    'text-halo-color': pal.halo,
                    'text-halo-width': 1.2
                }
            });
        }

        if (!map.getLayer(this.AIRPORTS_LAYER_ID)) {
            map.addLayer({
                id: this.AIRPORTS_LAYER_ID,
                type: 'circle',
                source: this.SOURCE_ID,
                'source-layer': this.AIRPORTS_SRC_LAYER,
                paint: {
                    // Uniform dot size for all airports - importance only
                    // affects *when* they appear (circle-opacity), not size.
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3, 10, 5],
                    'circle-color': pal.airport,
                    'circle-stroke-color': pal.stroke,
                    'circle-stroke-width': 1,
                    // Reveal less important airports only as you zoom in.
                    'circle-opacity': this.importanceOpacity(),
                    'circle-stroke-opacity': this.importanceOpacity()
                },
                layout: { visibility: vis(opts.showAirports && opts.showAirportIcons) }
            });
        }

        if (!map.getLayer(this.AIRPORT_LABELS_LAYER_ID)) {
            map.addLayer({
                id: this.AIRPORT_LABELS_LAYER_ID,
                type: 'symbol',
                source: this.SOURCE_ID,
                'source-layer': this.AIRPORTS_SRC_LAYER,
                minzoom: this.LABEL_MINZOOM.airport,
                layout: {
                    'text-field': ['get', 'ident'],
                    'text-font': ['Open Sans Regular'],
                    // Tied to the "Map Labels Size" slider.
                    'text-size': labelSize,
                    'text-offset': [0, 0.9],
                    'text-anchor': 'top',
                    'text-allow-overlap': false,
                    // Lower sort-key wins placement, so negate the importance
                    // score: major airports get labelled first when labels
                    // would otherwise collide.
                    'symbol-sort-key': ['*', ['to-number', ['get', 'score'], 0], -1],
                    visibility: vis(opts.showAirports && opts.showAirportLabels)
                },
                paint: {
                    'text-color': pal.airport,
                    'text-halo-color': pal.halo,
                    'text-halo-width': 1.4,
                    // Same importance gating as the dots, so a minor airport's
                    // label never appears before the airport itself.
                    'text-opacity': this.importanceOpacity()
                }
            });
        }

        // Heliports: a distinct marker (coloured disc + "H") so they read
        // differently from airports and can be toggled independently.
        if (!map.getLayer(this.HELIPORTS_LAYER_ID)) {
            map.addLayer({
                id: this.HELIPORTS_LAYER_ID,
                type: 'circle',
                source: this.SOURCE_ID,
                'source-layer': this.HELIPORTS_SRC_LAYER,
                paint: {
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 4, 12, 7],
                    'circle-color': pal.heliport,
                    'circle-stroke-color': pal.stroke,
                    'circle-stroke-width': 1
                },
                layout: { visibility: vis(opts.showAirports && opts.showHeliports) }
            });
        }

        if (!map.getLayer(this.HELIPORT_MARKER_LAYER_ID)) {
            map.addLayer({
                id: this.HELIPORT_MARKER_LAYER_ID,
                type: 'symbol',
                source: this.SOURCE_ID,
                'source-layer': this.HELIPORTS_SRC_LAYER,
                layout: {
                    'text-field': 'H',
                    'text-font': ['Open Sans Regular'],
                    'text-size': ['interpolate', ['linear'], ['zoom'], 7, 7, 12, 11],
                    // The "H" rides on its disc, so let it always draw.
                    'text-allow-overlap': true,
                    'text-ignore-placement': true,
                    visibility: vis(opts.showAirports && opts.showHeliports)
                },
                paint: {
                    'text-color': '#ffffff'
                }
            });
        }

        // Runway designators ("16L/34R"), only when zoomed right in. Rotated
        // (map-aligned) by the per-runway 'textrot' so they read along the strip.
        if (!map.getLayer(this.RUNWAY_LABELS_LAYER_ID)) {
            map.addLayer({
                id: this.RUNWAY_LABELS_LAYER_ID,
                type: 'symbol',
                source: this.SOURCE_ID,
                'source-layer': this.RUNWAYS_SRC_LAYER,
                minzoom: this.LABEL_MINZOOM.runway,
                layout: {
                    'text-field': ['get', 'ident'],
                    'text-font': ['Open Sans Regular'],
                    // Tied to the "Map Labels Size" slider.
                    'text-size': labelSize,
                    'text-rotate': ['get', 'textrot'],
                    'text-rotation-alignment': 'map',
                    'text-allow-overlap': false
                },
                paint: {
                    'text-color': opts.runwayColor || '#c8d2dc',
                    'text-halo-color': pal.halo,
                    'text-halo-width': 1.4
                }
            });
            this.setRunwayLabelVisibility(map, opts);
        }

        logger.debug('NavdataRenderer', 'Map layers created');
    }

    private setRunwayLabelVisibility(map: MapLibreMap, opts: DisplayOptions): void {
        if (map.getLayer(this.RUNWAY_LABELS_LAYER_ID)) {
            map.setLayoutProperty(
                this.RUNWAY_LABELS_LAYER_ID,
                'visibility',
                opts.showAirports && opts.showRunways && opts.showRunwayLabels ? 'visible' : 'none'
            );
        }
    }

    private updateDisplayOptions(opts: DisplayOptions): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const setVis = (layerId: string, on: boolean) => {
            if (map.getLayer(layerId)) {
                map.setLayoutProperty(layerId, 'visibility', on ? 'visible' : 'none');
            }
        };
        const setColor = (layerId: string, prop: string, color: string) => {
            if (map.getLayer(layerId)) {
                map.setPaintProperty(layerId, prop, color);
            }
        };
        const setSize = (layerId: string, size: number) => {
            if (map.getLayer(layerId)) {
                map.setLayoutProperty(layerId, 'text-size', size);
            }
        };

        setVis(this.PAVEMENT_FILL_LAYER_ID, opts.showAirports && opts.showPavement);
        setVis(this.RUNWAYS_FILL_LAYER_ID, opts.showAirports && opts.showRunways);
        setVis(this.RUNWAYS_LINE_LAYER_ID, opts.showAirports && opts.showRunways);
        setVis(this.RUNWAY_LABELS_LAYER_ID, opts.showAirports && opts.showRunways && opts.showRunwayLabels);
        setVis(this.WAYPOINTS_LAYER_ID, opts.showWaypoints && opts.showWaypointIcons);
        setVis(this.WAYPOINT_LABELS_LAYER_ID, opts.showWaypoints && opts.showWaypointLabels);
        setVis(this.AIRPORTS_LAYER_ID, opts.showAirports && opts.showAirportIcons);
        setVis(this.AIRPORT_LABELS_LAYER_ID, opts.showAirports && opts.showAirportLabels);
        setVis(this.HELIPORTS_LAYER_ID, opts.showAirports && opts.showHeliports);
        setVis(this.HELIPORT_MARKER_LAYER_ID, opts.showAirports && opts.showHeliports);

        // Theme-aware colours for the navdata symbols/labels. Runway and
        // pavement fills keep their own configured colours.
        const pal = this.getPalette();
        const runwayColor = opts.runwayColor || '#c8d2dc';
        const pavementColor = opts.pavementColor || '#5a6470';
        setColor(this.PAVEMENT_FILL_LAYER_ID, 'fill-color', pavementColor);
        setColor(this.RUNWAYS_FILL_LAYER_ID, 'fill-color', runwayColor);
        setColor(this.RUNWAYS_LINE_LAYER_ID, 'line-color', runwayColor);
        setColor(this.RUNWAY_LABELS_LAYER_ID, 'text-color', runwayColor);
        setColor(this.RUNWAY_LABELS_LAYER_ID, 'text-halo-color', pal.halo);
        setColor(this.WAYPOINTS_LAYER_ID, 'circle-color', pal.waypoint);
        setColor(this.WAYPOINT_LABELS_LAYER_ID, 'text-color', pal.waypoint);
        setColor(this.WAYPOINT_LABELS_LAYER_ID, 'text-halo-color', pal.halo);
        setColor(this.AIRPORTS_LAYER_ID, 'circle-color', pal.airport);
        setColor(this.AIRPORTS_LAYER_ID, 'circle-stroke-color', pal.stroke);
        setColor(this.AIRPORT_LABELS_LAYER_ID, 'text-color', pal.airport);
        setColor(this.AIRPORT_LABELS_LAYER_ID, 'text-halo-color', pal.halo);
        setColor(this.HELIPORTS_LAYER_ID, 'circle-color', pal.heliport);
        setColor(this.HELIPORTS_LAYER_ID, 'circle-stroke-color', pal.stroke);

        // Keep navdata label sizes tied to the "Map Labels Size" slider.
        const labelSize = opts.mapLabelsTextSize;
        setSize(this.AIRPORT_LABELS_LAYER_ID, labelSize);
        setSize(this.WAYPOINT_LABELS_LAYER_ID, Math.max(1, labelSize - 1));
        setSize(this.RUNWAY_LABELS_LAYER_ID, labelSize);
    }

    /**
     * Re-add layers after a basemap style change wipes them (mirrors the
     * pattern used by ShapeRenderer / MapOverlay).
     */
    public onStyleChange(): void {
        logger.debug('NavdataRenderer', 'Map style changed - recreating layers');
        const map = this.mapDisplay.getMap();
        if (!map) return;
        this.setupMapLayers(map);
    }

    public destroy(): void {
        this.initialized = false;
        logger.info('NavdataRenderer', 'Destroyed');
    }
}
