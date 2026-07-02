import maplibregl, { Map, MapOptions } from 'maplibre-gl';
import type { FitBoundsOptions, FlyToOptions } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { storage } from '../../utils/StorageManager';
import { logger } from '../../utils/Logger';
import { TerrainToggleControl } from './TerrainToggleControl';
import { MapStyleManager } from './MapStyleManager';

// Register the `pmtiles://` protocol once for the lifetime of the page so
// offline styles can read directly from a static .pmtiles archive. Guarded so
// reloading the MapDisplay module (HMR / test harnesses) does not re-register.
if (!window.__webatmPmtilesRegistered__) {
    maplibregl.addProtocol('pmtiles', new Protocol().tile);
    window.__webatmPmtilesRegistered__ = true;
}

/**
 * MapDisplay - Core map functionality
 *
 * Handles MapLibre GL map initialization, base map management, and map style selection.
 * This is the foundation for the radar display, providing the canvas for aircraft
 * and other visualizations.
 */
export class MapDisplay {
    private map: Map | null = null;
    private mapContainer: string;
    private currentProjection: 'mercator' | 'globe' = 'mercator';
    private styleChangeCallback: (() => void) | null = null;
    private mapLoadCallback: (() => void) | null = null;

    // Style selection, persistence, and offline fallback
    private readonly styleManager = new MapStyleManager(() => this.map);

    private readonly STORAGE_KEY_PROJECTION = 'webatm-map-projection';
    private readonly STORAGE_KEY_CENTER = 'map-center';
    private readonly STORAGE_KEY_ZOOM = 'map-zoom';

    // Always-present terrain toggle. Self-disables when the active style has
    // no raster-dem source. Created once in addControls() and refreshed on
    // every style.load.
    private terrainControl: TerrainToggleControl | null = null;

    // Keeps the map's internal transform (size + projection matrix) in sync
    // with the on-screen canvas. MapLibre only recomputes these on resize(),
    // but the container can change size from layout settling, scrollbars, or
    // panel drags without firing a window 'resize' event. A stale transform
    // makes unproject() (and therefore every e.lngLat) drift from the real
    // cursor position - which shows up as drawing previews not lining up with
    // the pointer. The observer resyncs on any container size change.
    private containerResizeObserver: ResizeObserver | null = null;

    // Detects device-pixel-ratio changes (e.g. dragging the window between a
    // Retina display and an external monitor). DPR changes do not fire a
    // 'resize' event, yet they require a resize() to keep the canvas buffer
    // and transform correct.
    private dprMediaQuery: MediaQueryList | null = null;
    private dprListener: (() => void) | null = null;

    // Default center and zoom for Amsterdam
    private readonly DEFAULT_CENTER: [number, number] = [4.9, 52.3];
    private readonly DEFAULT_ZOOM = 8;

    /**
     * Constructor
     * @param containerId - The ID of the HTML element to contain the map
     */
    constructor(containerId: string = 'map') {
        this.mapContainer = containerId;

        // Load saved projection from storage
        const savedProjection = storage.get<'mercator' | 'globe'>(this.STORAGE_KEY_PROJECTION);
        if (savedProjection === 'mercator' || savedProjection === 'globe') {
            this.currentProjection = savedProjection;
        }
    }

    /**
     * Initialize the map
     * Creates and configures the MapLibre GL map instance
     */
    public initialize(): void {
        if (this.map) {
            logger.warn('MapDisplay', 'Map already initialized');
            return;
        }

        // Get saved style from storage, or use default
        const initialStyle = this.styleManager.resolveInitialStyle();

        // Get saved view settings (center and zoom) from storage
        const savedCenter = storage.get<[number, number]>(this.STORAGE_KEY_CENTER);
        const savedZoom = storage.get<number>(this.STORAGE_KEY_ZOOM);

        const initialCenter = savedCenter || this.DEFAULT_CENTER;
        const initialZoom = savedZoom ?? this.DEFAULT_ZOOM;

        // Create map options
        const mapOptions: MapOptions = {
            container: this.mapContainer,
            style: initialStyle,
            center: initialCenter,
            zoom: initialZoom,
            pitch: 0,
            bearing: 0,
            // Disable MapLibre's symbol fade animation. The aircraft-labels
            // layer uses collision-based hiding (text-allow-overlap: false),
            // which fades labels in/out over 300 ms when their visibility
            // changes. BlueSky pushes aircraft data faster than 300 ms, so
            // each update re-runs placement and interrupts the in-flight
            // fades, producing visible label flicker. Setting fadeDuration
            // to 0 makes label show/hide instantaneous and removes the
            // flicker. The basemap (dark-matter-nolabels) has no symbol
            // labels, so this only affects WebATM's own entity layers.
            fadeDuration: 0,
            // Create the WebGL context with MSAA. The 3D aircraft layers
            // (CustomLayer3D) render Three.js content into MapLibre's
            // shared context, and antialiasing is a context-creation
            // attribute — the `antialias: true` passed to Three's
            // WebGLRenderer is ignored for an existing context. Without
            // this, 3D models render unantialiased and degrade into
            // jagged, stringy outlines once they are small on screen
            // (thin wings/stabilizers fall below one pixel), in both
            // mercator and globe projections.
            canvasContextAttributes: { antialias: true },
            // Render attribution as a fixed single line instead of the
            // compact expandable (i) button, whose auto expand/collapse
            // shifts layout after the style loads (counts towards CLS).
            attributionControl: { compact: false }
        };

        // Initialize the map
        this.map = new maplibregl.Map(mapOptions);

        // Add map controls
        this.addControls();

        // Set up event handlers
        this.setupEventHandlers();

        // If the initial style is remote, probe its reachability so an
        // air-gapped first load (where the CDN request hangs without ever
        // erroring) still swaps to the bundled offline basemap in seconds.
        this.styleManager.armFirstLoadFallback();

        // Keep the map transform synced to the container/canvas so cursor
        // positions (e.lngLat) always match the on-screen pointer.
        this.observeContainerResize();
        this.watchDevicePixelRatio();

        // Hide the map style message since we have a default style
        this.styleManager.hideMapStyleMessage();

        logger.info('MapDisplay', 'MapDisplay initialized with style:', initialStyle);
    }

    /**
     * Add map controls (navigation, scale)
     */
    private addControls(): void {
        if (!this.map) return;

        // Add navigation control (zoom buttons, compass)
        this.map.addControl(new maplibregl.NavigationControl(), 'top-left');

        // Add scale control
        this.map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

        // Add terrain toggle. Stays disabled until a style with a raster-dem
        // source is loaded.
        this.terrainControl = new TerrainToggleControl(1);
        this.map.addControl(this.terrainControl, 'top-left');

        logger.debug('MapDisplay', 'Map controls added');
    }

    /**
     * Set up map event handlers
     */
    private setupEventHandlers(): void {
        if (!this.map) return;

        // Handle map load event
        this.map.on('load', () => {
            logger.debug('MapDisplay', 'Map loaded');
            this.onMapLoad();
        });

        // Handle style load event (fired when style is loaded or changed)
        this.map.on('style.load', () => {
            logger.debug('MapDisplay', 'Map style loaded');
            this.onStyleLoad();
        });

        // Handle map errors (style fallback + noise suppression)
        this.map.on('error', (e) => {
            logger.error('MapDisplay', 'Map error:', e);
            this.styleManager.handleMapError(e);
        });

        // Handle move events for position display updates
        this.map.on('move', () => {
            this.onMapMove();
        });

        // Handle moveend events for bbox updates
        this.map.on('moveend', () => {
            this.onMapMoveEnd();
        });

        // Handle zoom events
        this.map.on('zoom', () => {
            this.onMapZoom();
        });
    }

    /**
     * Handle map load event
     */
    private onMapLoad(): void {
        logger.debug('MapDisplay', 'Map fully loaded and ready');

        // Invoke the map load callback if set
        if (this.mapLoadCallback) {
            this.mapLoadCallback();
        }
    }

    /**
     * Handle style load event
     */
    private onStyleLoad(): void {
        if (!this.map) return;

        // Set projection when style loads
        this.map.setProjection({
            type: this.currentProjection
        });

        logger.debug('MapDisplay', 'Map style loaded, projection set to:', this.currentProjection);

        // Refresh terrain control: enable if the new style declares a
        // raster-dem source, disable otherwise.
        this.terrainControl?.refresh();

        // Notify listeners that style has changed (for re-adding layers)
        if (this.styleChangeCallback) {
            this.styleChangeCallback();
        }

        // Resize to fix canvas/viewport sync after style load
        requestAnimationFrame(() => {
            this.map?.resize();
        });
    }

    /**
     * Handle map move event
     */
    private onMapMove(): void {
        // Override in subclass or via callback if needed
        // Used for updating position display
    }

    /**
     * Handle map moveend event
     */
    private onMapMoveEnd(): void {
        // Save the current map center to storage
        if (this.map) {
            const center = this.map.getCenter();
            storage.set(this.STORAGE_KEY_CENTER, [center.lng, center.lat]);
        }
        // Override in subclass or via callback if needed
        // Used for updating server bbox
    }

    /**
     * Handle map zoom event
     */
    private onMapZoom(): void {
        // Save the current zoom level to storage
        if (this.map) {
            const zoom = this.map.getZoom();
            storage.set(this.STORAGE_KEY_ZOOM, zoom);
        }
        // Override in subclass or via callback if needed
        // Used for updating labels and other zoom-dependent elements
    }

    /**
     * Change the map style (delegates to MapStyleManager)
     * @param styleUrl - URL of the new map style
     */
    public changeMapStyle(styleUrl: string): void {
        this.styleManager.changeStyle(styleUrl);
    }

    /**
     * Wire the settings-modal style selector (delegates to MapStyleManager)
     */
    public setupStyleSelector(): void {
        this.styleManager.setupStyleSelector();
    }




    /**
     * Toggle map projection between mercator and globe
     */
    public toggleProjection(): void {
        if (!this.map) {
            logger.error('MapDisplay', 'Cannot toggle projection: map not initialized');
            return;
        }

        // Toggle projection
        this.currentProjection = this.currentProjection === 'mercator' ? 'globe' : 'mercator';

        // Apply new projection
        this.map.setProjection({
            type: this.currentProjection
        });

        // Save to storage
        storage.set(this.STORAGE_KEY_PROJECTION, this.currentProjection);

        logger.debug('MapDisplay', 'Map projection changed to:', this.currentProjection);
    }

    /**
     * Get the current projection type
     */
    public getProjection(): 'mercator' | 'globe' {
        return this.currentProjection;
    }

    /**
     * Get the MapLibre GL map instance
     */
    public getMap(): Map | null {
        return this.map;
    }

    /**
     * Classify the active basemap as 'light' or 'dark' so overlays (e.g. the
     * navdata renderer) can pick a palette that reads well against it. The
     * known dark styles are the bundled offline-dark style, Dark Matter, and
     * the OpenFreeMap dark/fiord styles; everything else (Positron, Bright,
     * Liberty, MapTiler, custom URLs) uses the light palette.
     */
    public getMapTheme(): 'light' | 'dark' {
        const s = this.styleManager.getCurrentStyle() || '';
        if (s.includes('offline-style-light')) return 'light';
        if (s.includes('dark-matter') || s.includes('offline-style.json')) return 'dark';
        if (s.includes('openfreemap.org/styles/dark') || s.includes('openfreemap.org/styles/fiord')) return 'dark';
        return 'light';
    }

    /**
     * Check if map is initialized
     */
    public isInitialized(): boolean {
        return this.map !== null;
    }

    /**
     * Resize the map
     * Should be called when the container size changes
     */
    public resize(): void {
        if (this.map) {
            this.map.resize();
        }
    }

    /**
     * Observe the map container for size changes and resync the map transform.
     *
     * The ad-hoc window-resize and panel-drag listeners elsewhere only cover
     * a subset of the ways the container can change size. Layout settling
     * after fonts load, scrollbars appearing/disappearing, and flexbox
     * reflows can all resize the container without a window 'resize' event,
     * leaving MapLibre's cached transform stale. A stale transform makes
     * unproject() drift from the real pointer, so drawing previews (heading
     * guides, polygon/route lines) no longer line up with the cursor.
     *
     * The resize() call is deferred to the next animation frame to avoid the
     * "ResizeObserver loop completed with undelivered notifications" warning
     * that fires when resizing synchronously inside the observer callback.
     */
    private observeContainerResize(): void {
        if (typeof ResizeObserver === 'undefined') return;

        const container = document.getElementById(this.mapContainer);
        if (!container) {
            logger.warn('MapDisplay', 'Map container not found; cannot observe resize');
            return;
        }

        this.containerResizeObserver = new ResizeObserver(() => {
            requestAnimationFrame(() => {
                this.map?.resize();
            });
        });
        this.containerResizeObserver.observe(container);

        logger.debug('MapDisplay', 'Container resize observer attached');
    }

    /**
     * Resync the map when the device pixel ratio changes. This happens when
     * the browser window moves between displays with different scaling (for
     * example a Retina laptop screen and a 1x external monitor), which does
     * not fire a window 'resize' event but does require a resize() so the
     * canvas backing buffer and transform stay correct. matchMedia queries
     * are DPR-specific, so we re-arm the listener after each change.
     */
    private watchDevicePixelRatio(): void {
        if (typeof window.matchMedia !== 'function') return;

        // Tear down any previous query/listener before re-arming.
        if (this.dprMediaQuery && this.dprListener) {
            this.dprMediaQuery.removeEventListener('change', this.dprListener);
        }

        this.dprListener = () => {
            this.map?.resize();
            // The matched DPR has changed, so the query no longer applies;
            // build a fresh one for the new ratio.
            this.watchDevicePixelRatio();
        };

        this.dprMediaQuery = window.matchMedia(
            `(resolution: ${window.devicePixelRatio}dppx)`
        );
        this.dprMediaQuery.addEventListener('change', this.dprListener, {
            once: true
        });
    }

    /**
     * Get the map center
     */
    public getCenter(): [number, number] {
        if (!this.map) return this.DEFAULT_CENTER;
        const center = this.map.getCenter();
        return [center.lng, center.lat];
    }

    /**
     * Set the map center
     */
    public setCenter(lng: number, lat: number, zoom?: number): void {
        if (!this.map) return;

        const options: FlyToOptions = { center: [lng, lat] };
        if (zoom !== undefined) {
            options.zoom = zoom;
        }

        this.map.flyTo(options);
    }

    /**
     * Get the current zoom level
     */
    public getZoom(): number {
        if (!this.map) return this.DEFAULT_ZOOM;
        return this.map.getZoom();
    }

    /**
     * Set the zoom level
     */
    public setZoom(zoom: number): void {
        if (!this.map) return;
        this.map.setZoom(zoom);
    }

    /**
     * Zoom in by one level
     */
    public zoomIn(): void {
        if (!this.map) return;
        this.map.zoomIn();
    }

    /**
     * Zoom out by one level
     */
    public zoomOut(): void {
        if (!this.map) return;
        this.map.zoomOut();
    }

    /**
     * Pan to a specific location (animated)
     */
    public panTo(lat: number, lon: number): void {
        if (!this.map) return;
        this.map.panTo([lon, lat]);
    }

    /**
     * Get current map bounds
     * Returns [west, south, east, north] for MCRE commands
     */
    public getCurrentBounds(): number[] | null {
        if (!this.map) return null;

        const bounds = this.map.getBounds();
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();

        return [sw.lng, sw.lat, ne.lng, ne.lat];
    }

    /**
     * Fit the map to bounds
     */
    public fitBounds(bounds: [[number, number], [number, number]], options?: FitBoundsOptions): void {
        if (!this.map) return;
        this.map.fitBounds(bounds, options);
    }

    /**
     * Set a callback to be invoked when the map style changes
     * @param callback - Function to call when style loads
     */
    public onStyleChange(callback: () => void): void {
        this.styleChangeCallback = callback;
    }

    /**
     * Set a callback to be invoked when the map finishes loading
     * @param callback - Function to call when map loads
     */
    public setMapLoadCallback(callback: () => void): void {
        this.mapLoadCallback = callback;

        // If map is already loaded, invoke callback immediately
        if (this.map && this.map.loaded()) {
            callback();
        }
    }

    /**
     * Destroy the map and clean up resources
     */
    public destroy(): void {
        if (this.containerResizeObserver) {
            this.containerResizeObserver.disconnect();
            this.containerResizeObserver = null;
        }

        if (this.dprMediaQuery && this.dprListener) {
            this.dprMediaQuery.removeEventListener('change', this.dprListener);
            this.dprMediaQuery = null;
            this.dprListener = null;
        }

        if (this.map) {
            this.map.remove();
            this.map = null;
            this.styleChangeCallback = null;
            this.mapLoadCallback = null;
            logger.debug('MapDisplay', 'MapDisplay destroyed');
        }
    }
}
