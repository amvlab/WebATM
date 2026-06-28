import type { Map } from 'maplibre-gl';
import { storage } from '../../utils/StorageManager';
import { logger } from '../../utils/Logger';
import {
    loadSavedStyles,
    persistSavedStyles,
    upsertStyle,
    removeStyleByUrl,
} from './customStyles';

/**
 * Shape of the MapLibre 'error' events this manager inspects. MapLibre's
 * AJAXError adds `status` to the error; source errors add `sourceId`/`tile`.
 */
interface MapErrorEvent {
    error?: Error & { status?: number };
    sourceId?: string;
    tile?: unknown;
    type?: string;
    target?: unknown;
}

/**
 * MapStyleManager - basemap style selection, persistence, and offline
 * fallback, extracted from MapDisplay.
 *
 * Owns the saved-style storage key, the settings-modal style selector
 * wiring, and the one-shot fallback to the bundled offline style when
 * the remote basemap is unreachable.
 */
export class MapStyleManager {
    private readonly DEFAULT_STYLE = 'https://tiles.openfreemap.org/styles/positron';
    private readonly OFFLINE_STYLE = '/static/map/offline-style.json';
    private readonly STORAGE_KEY_STYLE = 'webatm-map-style';
    // DOM id of the runtime-injected <optgroup> that lists user-saved styles.
    private readonly SAVED_GROUP_ID = 'saved-custom-styles-group';

    // Tracks whether we've already swapped to the offline style after a
    // network failure, so we only attempt the fallback once.
    private hasFallenBackToOffline = false;
    private currentStyle: string = '';

    constructor(private readonly getMap: () => Map | null) {}

    /**
     * Resolve the style the map should start with: the user's saved
     * choice when present, the default basemap otherwise.
     */
    public resolveInitialStyle(): string {
        const savedStyle = storage.get<string>(this.STORAGE_KEY_STYLE);
        const initialStyle = savedStyle || this.DEFAULT_STYLE;
        this.currentStyle = initialStyle;
        return initialStyle;
    }

    /** The style URL currently applied (or being applied). */
    public getCurrentStyle(): string {
        return this.currentStyle;
    }

    /**
     * Change the map style
     * @param styleUrl - URL of the new map style
     */
    public changeStyle(styleUrl: string): void {
        const map = this.getMap();
        if (!map) {
            logger.error('MapStyleManager', 'Cannot change style: map not initialized');
            return;
        }

        try {
            logger.debug('MapStyleManager', 'Changing map style to:', styleUrl);

            // Save the style to storage for persistence
            storage.set(this.STORAGE_KEY_STYLE, styleUrl);
            this.currentStyle = styleUrl;

            // Change the map style
            // Note: the styleChangeCallback is already called from MapDisplay's
            // persistent 'style.load' handler, so we only need to trigger a
            // resize after the style settles.
            map.once('idle', () => {
                // Resize to fix canvas/viewport sync after style change
                this.getMap()?.resize();
            });

            map.setStyle(styleUrl);

            // Hide the map style message now that a style has been selected
            this.hideMapStyleMessage();

        } catch (error) {
            logger.error('MapStyleManager', 'Error changing map style:', error);
            alert(`Error changing map style: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Route a MapLibre 'error' event: fall back to the offline basemap on
     * network failures, suppress known non-critical errors, log the rest.
     */
    public handleMapError(e: MapErrorEvent): void {
        // Log detailed error information
        logger.error('MapStyleManager', 'Map error details:', {
            error: e.error,
            sourceId: e.sourceId,
            tile: e.tile,
            type: e.type,
            target: e.target
        });

        // If the current style is a remote URL and we're hitting what looks
        // like a network failure (AJAXError / status 0 / fetch rejection),
        // fall back to the bundled offline style. Guarded so we only try once.
        if (this.shouldFallBackToOffline(e)) {
            this.hasFallenBackToOffline = true;
            logger.warn('MapStyleManager', 'Remote style unreachable; switching to offline basemap.');
            this.changeStyle(this.OFFLINE_STYLE);
            return;
        }

        // Check for common errors and suppress non-critical ones
        if (e.error) {
            const errorMsg = e.error.message || String(e.error);

            // Suppress font loading errors (non-critical)
            if (errorMsg.includes('Could not load') && errorMsg.includes('font')) {
                logger.verbose('MapStyleManager', 'Font loading error (non-critical):', errorMsg);
                return;
            }

            // Suppress tile loading errors during sprite updates (transient)
            if (errorMsg.includes('tile') || errorMsg.includes('Tile')) {
                logger.verbose('MapStyleManager', 'Tile loading error (may be transient):', errorMsg);
                return;
            }
        }

        // Log other errors for debugging
        logger.error('MapStyleManager', 'Map style error:', e);
    }

    /**
     * Decide whether a MapLibre error warrants swapping to the offline style.
     *
     * MapLibre surfaces a few shapes for network failures: AJAXError objects
     * with a `status` field (0 when the browser couldn't reach the host at
     * all), and generic `TypeError: Failed to fetch` for cross-origin / DNS
     * problems. We only fall back once, and only if the current style is a
     * remote URL — local styles failing usually mean a config mistake, not
     * missing internet.
     *
     * Crucially we do NOT fall back on individual *tile* fetch failures (errors
     * that carry a `tile`). Those are common and transient — a single dropped
     * or CORS-blocked vector tile while panning should not swap the entire
     * basemap to offline. Swapping the style mid-session reloads every layer:
     * the basemap visibly flickers, and (with the 3D overlay on) rebuilding the
     * Three.js custom layer disrupts the viewport and snaps the camera back to
     * the default view. The map degrades gracefully on a missing tile (the
     * tile is simply blank until it succeeds), so a tile error is never reason
     * enough to nuke the user's chosen basemap. A genuinely-offline boot still
     * triggers the fallback because the *style document* fetch fails, and that
     * error carries no `tile`.
     */
    private shouldFallBackToOffline(e: MapErrorEvent): boolean {
        if (this.hasFallenBackToOffline) return false;
        if (!this.currentStyle.startsWith('http')) return false;

        // Individual tile failures are transient; never fall back on them.
        if (e.tile) return false;

        const err = e?.error;
        if (!err) return false;

        const status = typeof err.status === 'number' ? err.status : null;
        const message = (err.message || String(err)).toLowerCase();

        // status 0 = no response (offline / DNS / CORS preflight failure).
        // "failed to fetch" is Chromium's TypeError for the same thing.
        return (
            status === 0 ||
            message.includes('failed to fetch') ||
            message.includes('networkerror')
        );
    }

    /**
     * Set up map style selector event handlers
     * This connects the HTML select element to the map style changing logic
     */
    public setupStyleSelector(): void {
        const styleSelect = document.getElementById('map-style-select-modal') as HTMLSelectElement;
        const customStyleControl = document.getElementById('custom-style-control-modal');
        const customStyleInput = document.getElementById('custom-style-url-modal') as HTMLInputElement;
        const customStyleNameInput = document.getElementById('custom-style-name-modal') as HTMLInputElement;
        const applyCustomStyleBtn = document.getElementById('apply-custom-style-modal');
        const saveCustomStyleBtn = document.getElementById('save-custom-style-modal');
        const applyMapStyleBtn = document.getElementById('apply-map-style-btn') as HTMLButtonElement;
        const deleteSavedStyleBtn = document.getElementById('delete-saved-style-btn') as HTMLButtonElement;

        if (!styleSelect) {
            logger.warn('MapStyleManager', 'Map style select element not found');
            return;
        }

        // Populate the dropdown with any styles the user has saved previously.
        this.renderSavedStyles(styleSelect);

        // Show the "Delete Saved Style" button only when a user-saved style is
        // the current selection (saved options carry data-saved-style="true").
        const updateDeleteButton = (): void => {
            if (!deleteSavedStyleBtn) return;
            const selected = styleSelect.selectedOptions[0];
            const isSaved = selected?.dataset.savedStyle === 'true';
            deleteSavedStyleBtn.style.display = isSaved ? 'block' : 'none';
        };

        // Handle style select change - only toggle custom input visibility
        styleSelect.addEventListener('change', (e) => {
            const target = e.target as HTMLSelectElement;

            if (target.value === 'custom') {
                // Show custom style input
                if (customStyleControl) {
                    customStyleControl.style.display = 'block';
                }
                // Hide apply button for predefined styles
                if (applyMapStyleBtn) {
                    applyMapStyleBtn.style.display = 'none';
                }
            } else if (target.value === '') {
                // User selected "Select a map style..." placeholder
                if (customStyleControl) {
                    customStyleControl.style.display = 'none';
                }
            } else {
                // User selected a predefined style - just hide custom input
                if (customStyleControl) {
                    customStyleControl.style.display = 'none';
                }
                // Show apply button for predefined styles
                if (applyMapStyleBtn) {
                    applyMapStyleBtn.style.display = 'block';
                }
            }

            updateDeleteButton();
        });

        // Handle apply map style button - applies the selected style from dropdown
        if (applyMapStyleBtn) {
            applyMapStyleBtn.addEventListener('click', () => {
                const selectedValue = styleSelect.value;

                if (selectedValue === '' || selectedValue === 'custom') {
                    // Don't apply if placeholder or custom is selected
                    return;
                }

                const styleUrl = selectedValue;

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
                    this.changeStyle(urlWithKey);
                } else {
                    // Change the map style without API key
                    this.changeStyle(styleUrl);
                }
            });
        }

        // Handle custom style apply button
        if (applyCustomStyleBtn) {
            applyCustomStyleBtn.addEventListener('click', () => {
                if (customStyleInput && customStyleInput.value.trim()) {
                    const customUrl = customStyleInput.value.trim();
                    this.changeStyle(customUrl);
                } else {
                    alert('Please enter a valid style URL.');
                }
            });
        }

        // Handle "Save Style": persist the custom URL under a name, add it to
        // the dropdown, select it, and apply it so it's usable immediately.
        if (saveCustomStyleBtn) {
            saveCustomStyleBtn.addEventListener('click', () => {
                const url = customStyleInput?.value.trim() ?? '';
                const name = customStyleNameInput?.value.trim() ?? '';

                if (!url) {
                    alert('Please enter a style URL to save.');
                    return;
                }
                if (!name) {
                    alert('Please enter a name for this style.');
                    return;
                }

                persistSavedStyles(upsertStyle(loadSavedStyles(), name, url));
                this.renderSavedStyles(styleSelect);

                // Select and apply the newly-saved style; clear the name field.
                styleSelect.value = url;
                if (customStyleNameInput) customStyleNameInput.value = '';
                this.changeStyle(url);
                styleSelect.dispatchEvent(new Event('change'));
            });
        }

        // Handle "Delete Saved Style": remove the selected user-saved style and
        // reset the dropdown to the placeholder.
        if (deleteSavedStyleBtn) {
            deleteSavedStyleBtn.addEventListener('click', () => {
                const selected = styleSelect.selectedOptions[0];
                if (!selected || selected.dataset.savedStyle !== 'true') return;

                const label = selected.textContent || 'this style';
                if (!confirm(`Delete saved style "${label}"?`)) return;

                persistSavedStyles(removeStyleByUrl(loadSavedStyles(), selected.value));
                this.renderSavedStyles(styleSelect);

                styleSelect.value = '';
                styleSelect.dispatchEvent(new Event('change'));
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
                        // Trigger the apply button click instead of change event
                        if (applyMapStyleBtn) {
                            applyMapStyleBtn.click();
                        }
                    }
                }
            });
        }

        logger.debug('MapStyleManager', 'Map style selector initialized');
    }

    /**
     * (Re)build the "Saved Styles" optgroup in the style dropdown from the
     * persisted custom-style list. The group is inserted just above the
     * trailing "Custom Style JSON..." option, and each option carries
     * data-saved-style="true" so the change handler can offer a delete action.
     */
    private renderSavedStyles(select: HTMLSelectElement): void {
        // Drop any previously-rendered group before rebuilding.
        select.querySelector(`#${this.SAVED_GROUP_ID}`)?.remove();

        const styles = loadSavedStyles();
        if (styles.length === 0) return;

        const group = document.createElement('optgroup');
        group.id = this.SAVED_GROUP_ID;
        group.label = 'Saved Styles';

        for (const s of styles) {
            const opt = document.createElement('option');
            opt.value = s.url;
            opt.textContent = s.name;
            opt.dataset.savedStyle = 'true';
            group.appendChild(opt);
        }

        const customOption = select.querySelector('option[value="custom"]');
        if (customOption) {
            select.insertBefore(group, customOption);
        } else {
            select.appendChild(group);
        }
    }

    /**
     * Hide the map style message overlay
     */
    public hideMapStyleMessage(): void {
        const messageElement = document.getElementById('map-style-message');
        if (messageElement) {
            messageElement.style.display = 'none';
            logger.verbose('MapStyleManager', 'Map style message hidden');
        }
    }
}
