import type { MapDisplay } from './MapDisplay';
import { logger } from '../../utils/Logger';

interface NavSearchResult {
    kind: 'airport' | 'heliport' | 'waypoint';
    ident: string;
    name: string;
    lat: number;
    lon: number;
    // IATA code, when known (airports only); empty string otherwise.
    iata?: string;
}

/**
 * NavSearchBox - "go to" search for airports and waypoints.
 *
 * Queries the /api/navdata/search endpoint (backed by the offline-built SQLite
 * index) and flies the map to the chosen result. Wired to the static markup in
 * index.html (#nav-search-input / #nav-search-results).
 */
export class NavSearchBox {
    private mapDisplay: MapDisplay;
    private input: HTMLInputElement | null = null;
    private results: HTMLElement | null = null;
    private debounceTimer: number | null = null;
    private activeIndex = -1;
    private current: NavSearchResult[] = [];

    // Zoom levels the map flies to when a result is selected.
    private readonly AIRPORT_ZOOM = 11;
    private readonly WAYPOINT_ZOOM = 9;

    constructor(mapDisplay: MapDisplay) {
        this.mapDisplay = mapDisplay;
    }

    public init(): void {
        this.input = document.getElementById('nav-search-input') as HTMLInputElement | null;
        this.results = document.getElementById('nav-search-results');
        if (!this.input || !this.results) {
            logger.warn('NavSearchBox', 'Search box markup not found - skipping init');
            return;
        }

        this.input.addEventListener('input', () => this.onInput());
        this.input.addEventListener('keydown', (e) => this.onKeyDown(e));
        // Hide the dropdown when focus leaves the widget (slight delay so a
        // click on a result still registers before it is removed).
        this.input.addEventListener('blur', () => {
            window.setTimeout(() => this.hideResults(), 150);
        });
        this.input.addEventListener('focus', () => {
            if (this.current.length) this.showResults();
        });

        logger.debug('NavSearchBox', 'Initialized');
    }

    private onInput(): void {
        const query = this.input?.value.trim() ?? '';
        if (this.debounceTimer !== null) {
            window.clearTimeout(this.debounceTimer);
        }
        if (query.length < 1) {
            this.current = [];
            this.hideResults();
            return;
        }
        this.debounceTimer = window.setTimeout(() => this.search(query), 200);
    }

    private async search(query: string): Promise<void> {
        try {
            const resp = await fetch(
                `/api/navdata/search?q=${encodeURIComponent(query)}&limit=10`
            );
            const data = await resp.json();
            if (!data.success) {
                this.renderMessage(
                    data.error === 'navdata index not built'
                        ? 'Navdata not available (run the offline build).'
                        : 'Search failed.'
                );
                return;
            }
            this.current = data.results as NavSearchResult[];
            this.activeIndex = -1;
            this.renderResults();
        } catch (err) {
            logger.error('NavSearchBox', 'Search request failed:', err);
            this.renderMessage('Search failed.');
        }
    }

    private renderResults(): void {
        if (!this.results) return;
        if (this.current.length === 0) {
            this.renderMessage('No matches.');
            return;
        }
        this.results.innerHTML = '';
        this.current.forEach((r, i) => {
            const item = document.createElement('div');
            item.className = 'nav-search-item';
            item.dataset.index = String(i);
            const badge =
                r.kind === 'airport' ? 'APT' : r.kind === 'heliport' ? 'HEL' : 'WPT';
            item.innerHTML =
                `<span class="nav-search-badge nav-search-badge-${r.kind}">${badge}</span>` +
                `<span class="nav-search-ident">${this.escape(r.ident)}</span>` +
                (r.iata ? `<span class="nav-search-iata">${this.escape(r.iata)}</span>` : '') +
                (r.name ? `<span class="nav-search-name">${this.escape(r.name)}</span>` : '');
            // mousedown (not click) so it fires before the input's blur handler.
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this.select(i);
            });
            this.results!.appendChild(item);
        });
        this.showResults();
    }

    private renderMessage(message: string): void {
        if (!this.results) return;
        this.results.innerHTML = `<div class="nav-search-message">${this.escape(message)}</div>`;
        this.showResults();
    }

    private onKeyDown(e: KeyboardEvent): void {
        if (this.current.length === 0) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.activeIndex = Math.min(this.activeIndex + 1, this.current.length - 1);
            this.highlight();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.activeIndex = Math.max(this.activeIndex - 1, 0);
            this.highlight();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            this.select(this.activeIndex >= 0 ? this.activeIndex : 0);
        } else if (e.key === 'Escape') {
            this.hideResults();
            this.input?.blur();
        }
    }

    private highlight(): void {
        if (!this.results) return;
        const items = this.results.querySelectorAll('.nav-search-item');
        items.forEach((el, i) => {
            el.classList.toggle('active', i === this.activeIndex);
        });
    }

    private select(index: number): void {
        const r = this.current[index];
        if (!r) return;
        const zoom = r.kind === 'waypoint' ? this.WAYPOINT_ZOOM : this.AIRPORT_ZOOM;
        this.mapDisplay.setCenter(r.lon, r.lat, zoom);
        if (this.input) {
            this.input.value = r.ident;
        }
        this.hideResults();
    }

    private showResults(): void {
        if (this.results) this.results.style.display = 'block';
    }

    private hideResults(): void {
        if (this.results) this.results.style.display = 'none';
    }

    private escape(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
