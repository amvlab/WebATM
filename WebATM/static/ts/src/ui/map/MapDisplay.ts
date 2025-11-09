import maplibregl, { Map, NavigationControl, ScaleControl, MapOptions } from 'maplibre-gl';
import { storage } from '../../utils/StorageManager';
import { settingsModal } from '../SettingsModal';
import { logger } from '../../utils/Logger';

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

    // Map style constants
    private readonly DEFAULT_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';
    private readonly STORAGE_KEY_STYLE = 'webatm-map-style';
    private readonly STORAGE_KEY_PROJECTION = 'webatm-map-projection';
    private readonly STORAGE_KEY_CENTER = 'map-center';
    private readonly STORAGE_KEY_ZOOM = 'map-zoom';

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
        const savedStyle = storage.get<string>(this.STORAGE_KEY_STYLE);
        const initialStyle = savedStyle || this.DEFAULT_STYLE;

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
            bearing: 0
        };

        // Initialize the map
        this.map = new maplibregl.Map(mapOptions);

        // Add map controls
        this.addControls();

        // Set up event handlers
        this.setupEventHandlers();

        // Hide the map style message since we have a default style
        this.hideMapStyleMessage();

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

        // Handle map errors
        this.map.on('error', (e) => {
            logger.error('MapDisplay', 'Map error:', e);
            this.onMapError(e);
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

        // Notify listeners that style has changed (for re-adding layers)
        if (this.styleChangeCallback) {
            this.styleChangeCallback();
        }
    }

    /**
     * Handle map error event
     */
    private onMapError(e: any): void {
        // Log detailed error information
        logger.error('MapDisplay', 'Map error details:', {
            error: e.error,
            sourceId: e.sourceId,
            tile: e.tile,
            type: e.type,
            target: e.target
        });

        // Check for common errors and suppress non-critical ones
        if (e.error) {
            const errorMsg = e.error.message || String(e.error);

            // Suppress font loading errors (non-critical)
            if (errorMsg.includes('Could not load') && errorMsg.includes('font')) {
                logger.verbose('MapDisplay', 'Font loading error (non-critical):', errorMsg);
                return;
            }

            // Suppress tile loading errors during sprite updates (transient)
            if (errorMsg.includes('tile') || errorMsg.includes('Tile')) {
                logger.verbose('MapDisplay', 'Tile loading error (may be transient):', errorMsg);
                return;
            }
        }

        // Log other errors for debugging
        logger.error('MapDisplay', 'Map style error:', e);
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
     * Change the map style
     * @param styleUrl - URL of the new map style
     */
    public changeMapStyle(styleUrl: string): void {
        if (!this.map) {
            logger.error('MapDisplay', 'Cannot change style: map not initialized');
            return;
        }

        try {
            logger.debug('MapDisplay', 'Changing map style to:', styleUrl);

            // Save the style to storage for persistence
            storage.set(this.STORAGE_KEY_STYLE, styleUrl);

            // Change the map style
            this.map.setStyle(styleUrl);

            // Hide the map style message now that a style has been selected
            this.hideMapStyleMessage();

            // Note: 'style.load' event will fire after style is loaded,
            // where we'll reset projection and reload layers
        } catch (error) {
            logger.error('MapDisplay', 'Error changing map style:', error);
            alert(`Error changing map style: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Set up map style selector event handlers
     * This connects the HTML select element to the map style changing logic
     */
    public setupStyleSelector(): void {
        const styleSelect = document.getElementById('map-style-select-modal') as HTMLSelectElement;
        const customStyleControl = document.getElementById('custom-style-control-modal');
        const customStyleInput = document.getElementById('custom-style-url-modal') as HTMLInputElement;
        const applyCustomStyleBtn = document.getElementById('apply-custom-style-modal');

        if (!styleSelect) {
            logger.warn('MapDisplay', 'Map style select element not found');
            return;
        }

        // Handle style select change
        styleSelect.addEventListener('change', (e) => {
            const target = e.target as HTMLSelectElement;
            const selectedOption = target.selectedOptions[0];

            if (target.value === 'custom') {
                // Show custom style input
                if (customStyleControl) {
                    customStyleControl.style.display = 'block';
                }
            } else if (target.value === '') {
                // User selected "Select a map style..." placeholder
                if (customStyleControl) {
                    customStyleControl.style.display = 'none';
                }
            } else {
                // User selected a predefined style
                if (customStyleControl) {
                    customStyleControl.style.display = 'none';
                }

                const styleUrl = target.value;

                // Handle MapTiler URLs that need API key
                if (styleUrl.includes('api.maptiler.com') && styleUrl.endsWith('?key=')) {
                    const apiKeyInput = document.getElementById('maptiler-api-key-input') as HTMLInputElement;
                    const apiKey = apiKeyInput?.value.trim();
                    
                    if (!apiKey) {
                        alert('MapTiler API key is required. Please enter your API key in the field above.');
                        return;
                    }
                    
                    // Append the API key to the URL
                    const urlWithKey = styleUrl + apiKey;
                    this.changeMapStyle(urlWithKey);
                } else {
                    // Change the map style without API key
                    this.changeMapStyle(styleUrl);
                }
            }
        });

        // Handle custom style apply button
        if (applyCustomStyleBtn) {
            applyCustomStyleBtn.addEventListener('click', () => {
                if (customStyleInput && customStyleInput.value.trim()) {
                    const customUrl = customStyleInput.value.trim();
                    this.changeMapStyle(customUrl);
                } else {
                    alert('Please enter a valid style URL.');
                }
            });
        }

        // Handle Enter key in custom style input
        if (customStyleInput) {
            customStyleInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && applyCustomStyleBtn) {
                    applyCustomStyleBtn.click();
                }
            });
        }

        // Handle Enter key in MapTiler API key input
        const apiKeyInput = document.getElementById('maptiler-api-key-input') as HTMLInputElement;
        if (apiKeyInput) {
            apiKeyInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    // Try to apply the currently selected MapTiler style if one is selected
                    const currentStyle = styleSelect.value;
                    if (currentStyle.includes('api.maptiler.com')) {
                        styleSelect.dispatchEvent(new Event('change'));
                    }
                }
            });
        }

        logger.debug('MapDisplay', 'Map style selector initialized');
    }


    /**
     * Hide the map style message overlay
     */
    private hideMapStyleMessage(): void {
        const messageElement = document.getElementById('map-style-message');
        if (messageElement) {
            messageElement.style.display = 'none';
            logger.verbose('MapDisplay', 'Map style message hidden');
        }
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

        const options: any = { center: [lng, lat] };
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
    public fitBounds(bounds: [[number, number], [number, number]], options?: any): void {
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
        if (this.map) {
            this.map.remove();
            this.map = null;
            this.styleChangeCallback = null;
            this.mapLoadCallback = null;
            logger.debug('MapDisplay', 'MapDisplay destroyed');
        }
    }
}
