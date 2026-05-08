import type { Map, IControl } from 'maplibre-gl';
import { logger } from '../../utils/Logger';

const DISABLED_TITLE = 'Terrain not available in this map style';
const ENABLE_TITLE = 'Enable terrain';
const DISABLE_TITLE = 'Disable terrain';

/**
 * TerrainToggleControl - Always-present terrain toggle button.
 *
 * Unlike MapLibre's built-in TerrainControl, this control stays in the DOM
 * across style changes. When the active style declares a `raster-dem` source,
 * the button is enabled and toggles 3D terrain. Otherwise it shows greyed-out
 * with a tooltip explaining that the current style has no terrain data.
 */
export class TerrainToggleControl implements IControl {
    private map: Map | null = null;
    private container: HTMLDivElement | null = null;
    private button: HTMLButtonElement | null = null;
    private demSourceId: string | null = null;
    private terrainOn = false;
    private readonly exaggeration: number;

    constructor(exaggeration: number = 1) {
        this.exaggeration = exaggeration;
    }

    public onAdd(map: Map): HTMLElement {
        this.map = map;

        this.container = document.createElement('div');
        this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

        this.button = document.createElement('button');
        this.button.type = 'button';
        this.button.className = 'maplibregl-ctrl-terrain';
        this.button.setAttribute('aria-label', ENABLE_TITLE);
        this.button.title = DISABLED_TITLE;

        const icon = document.createElement('span');
        icon.className = 'maplibregl-ctrl-icon';
        icon.setAttribute('aria-hidden', 'true');
        this.button.appendChild(icon);

        this.button.addEventListener('click', () => this.handleClick());
        this.container.appendChild(this.button);

        this.refresh();

        return this.container;
    }

    public onRemove(): void {
        this.container?.parentNode?.removeChild(this.container);
        this.container = null;
        this.button = null;
        this.map = null;
    }

    /**
     * Re-scan the active style for a raster-dem source and update button state.
     * Should be called after every `style.load`.
     */
    public refresh(): void {
        if (!this.map || !this.button) return;

        this.demSourceId = this.findDemSourceId();
        const enabled = this.demSourceId !== null;

        this.button.disabled = !enabled;
        this.button.classList.toggle('maplibregl-ctrl-terrain-disabled', !enabled);

        if (!enabled) {
            this.terrainOn = false;
            this.button.classList.remove('maplibregl-ctrl-terrain-enabled');
            this.button.title = DISABLED_TITLE;
            this.button.setAttribute('aria-label', DISABLED_TITLE);
            return;
        }

        // Style may already have terrain set (e.g. declared in style JSON).
        const styleTerrain = (this.map.getStyle() as any).terrain;
        this.terrainOn = !!styleTerrain;
        this.setHillshadeVisibility(this.terrainOn);
        this.updateActiveLook();
    }

    /**
     * Toggle visibility on every hillshade layer that draws from the active
     * raster-dem source. Hillshade is treated as part of the terrain feature,
     * so it appears/disappears together with the 3D toggle.
     */
    private setHillshadeVisibility(visible: boolean): void {
        if (!this.map || !this.demSourceId) return;
        const layers = this.map.getStyle()?.layers ?? [];
        const value = visible ? 'visible' : 'none';
        for (const layer of layers) {
            if (
                layer.type === 'hillshade' &&
                (layer as any).source === this.demSourceId
            ) {
                try {
                    this.map.setLayoutProperty(layer.id, 'visibility', value);
                } catch (error) {
                    logger.warn('TerrainToggleControl', `Failed to set hillshade visibility for ${layer.id}:`, error);
                }
            }
        }
    }

    private findDemSourceId(): string | null {
        if (!this.map) return null;
        const sources = this.map.getStyle()?.sources ?? {};
        for (const [id, source] of Object.entries(sources)) {
            if ((source as any)?.type === 'raster-dem') {
                return id;
            }
        }
        return null;
    }

    private handleClick(): void {
        if (!this.map || !this.demSourceId || this.button?.disabled) return;

        try {
            if (this.terrainOn) {
                this.map.setTerrain(null);
                this.terrainOn = false;
            } else {
                this.map.setTerrain({
                    source: this.demSourceId,
                    exaggeration: this.exaggeration
                });
                this.terrainOn = true;
            }
            this.setHillshadeVisibility(this.terrainOn);
            this.updateActiveLook();
        } catch (error) {
            logger.error('TerrainToggleControl', 'Failed to toggle terrain:', error);
        }
    }

    private updateActiveLook(): void {
        if (!this.button) return;
        this.button.classList.toggle('maplibregl-ctrl-terrain-enabled', this.terrainOn);
        const title = this.terrainOn ? DISABLE_TITLE : ENABLE_TITLE;
        this.button.title = title;
        this.button.setAttribute('aria-label', title);
    }
}
