/**
 * Search/autocomplete for BlueSky variable-explorer names in the Create Log
 * dialog. The index is discovered live from the connected simulation via
 * LSVAR replies (discoverVariableAttributes): the top-level parents ('traf',
 * 'sim') are indexed when the dialog opens, and sub-objects (e.g.
 * 'traf.perf') are drilled into lazily when the typed text reaches them
 * ("traf.perf." or a filter that matches their prefix).
 */
import { logger } from '../../utils/Logger';
import { escapeHtml } from '../../utils/dom';
import { discoverVariableAttributes, type VariableCheckerDeps } from './logVariableChecker';

/** Object paths indexed as soon as the dialog opens. */
const ROOT_PARENTS = ['traf', 'sim'] as const;

const MAX_SUGGESTIONS = 8;

export class VariableSearchIndex {
    // parent path -> attribute names under it (null = known to have none /
    // not discoverable, so we do not retry every keystroke)
    private attributes = new Map<string, string[] | null>();
    private pending = new Set<string>();
    private makeDeps: () => VariableCheckerDeps;
    private onUpdated: () => void;

    /**
     * @param makeDeps Supplies the LSVAR round-trip dependencies.
     * @param onUpdated Called whenever new names enter the index (so an open
     *                  suggestion list can refresh).
     */
    constructor(makeDeps: () => VariableCheckerDeps, onUpdated: () => void) {
        this.makeDeps = makeDeps;
        this.onUpdated = onUpdated;
    }

    /** Discover the root parents (called when the dialog opens). */
    public seed(): void {
        for (const parent of ROOT_PARENTS) {
            void this.discover(parent);
        }
    }

    /** Forget everything (e.g. after connecting to a different server). */
    public clear(): void {
        this.attributes.clear();
        this.pending.clear();
    }

    private async discover(parent: string): Promise<void> {
        if (this.attributes.has(parent) || this.pending.has(parent)) return;
        this.pending.add(parent);
        try {
            const attrs = await discoverVariableAttributes(parent, this.makeDeps());
            this.attributes.set(parent, attrs && attrs.length > 0 ? attrs : null);
            if (attrs && attrs.length > 0) {
                logger.debug('VariableSearchIndex', `${parent}: ${attrs.length} attributes`);
                this.onUpdated();
            }
        } finally {
            this.pending.delete(parent);
        }
    }

    /** All fully-qualified names currently in the index. */
    private allNames(): string[] {
        const names: string[] = [];
        this.attributes.forEach((attrs, parent) => {
            if (!attrs) return;
            for (const attr of attrs) {
                names.push(`${parent}.${attr}`);
            }
        });
        return names;
    }

    /**
     * Names matching `query` (case-insensitive), prefix matches first — both
     * on the full dotted name and on the last component, so "mass" finds
     * traf.perf.mass once traf.perf is indexed. Also kicks off a lazy drill
     * into "a.b" when the query looks like "a.b." or "a.b.c", so deeper
     * names stream into the index (onUpdated re-runs the search).
     */
    public search(query: string): string[] {
        const q = query.trim().toLowerCase();
        if (!q) return [];

        // Lazy drill-down: everything up to the last dot names an object path
        const lastDot = q.lastIndexOf('.');
        if (lastDot > 0) {
            const parent = q.slice(0, lastDot);
            if (/^[a-z_][a-z0-9_.]*$/.test(parent)) {
                void this.discover(parent);
            }
        }

        const starts: string[] = [];
        const contains: string[] = [];
        for (const name of this.allNames()) {
            const lower = name.toLowerCase();
            const lastComponent = lower.slice(lower.lastIndexOf('.') + 1);
            if (lower.startsWith(q) || lastComponent.startsWith(q)) {
                starts.push(name);
            } else if (lower.includes(q)) {
                contains.push(name);
            }
        }
        starts.sort();
        contains.sort();
        return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
    }
}

/**
 * Suggestion dropdown attached to the custom-variable input: filters the
 * index as the user types, supports ArrowUp/Down + Enter + click to pick,
 * and Escape to dismiss (without closing the surrounding modal).
 */
export class VariableSuggestDropdown {
    private input: HTMLInputElement;
    private listEl: HTMLElement;
    private index: VariableSearchIndex;
    private onPick: (name: string) => void;

    private items: string[] = [];
    private activeIndex = -1;
    private debounce: ReturnType<typeof setTimeout> | null = null;

    constructor(
        input: HTMLInputElement,
        listEl: HTMLElement,
        index: VariableSearchIndex,
        onPick: (name: string) => void
    ) {
        this.input = input;
        this.listEl = listEl;
        this.index = index;
        this.onPick = onPick;

        this.input.addEventListener('input', () => {
            if (this.debounce) clearTimeout(this.debounce);
            this.debounce = setTimeout(() => this.refresh(), 150);
        });
        this.input.addEventListener('keydown', (e) => this.onKeydown(e));
        // Delay so a click on a suggestion lands before the list disappears
        this.input.addEventListener('blur', () => {
            setTimeout(() => this.close(), 150);
        });
        this.listEl.addEventListener('mousedown', (e) => {
            const item = (e.target as HTMLElement)?.closest('[data-suggest]') as HTMLElement | null;
            if (!item) return;
            e.preventDefault(); // keep focus on the input
            this.pick(item.dataset.suggest || '');
        });
    }

    /** Re-run the search for the current input value (also used by onUpdated). */
    public refresh(): void {
        if (document.activeElement !== this.input) return;
        this.items = this.index.search(this.input.value);
        this.activeIndex = this.items.length > 0 ? 0 : -1;
        this.render();
    }

    public isOpen(): boolean {
        return this.listEl.style.display !== 'none';
    }

    public close(): void {
        this.listEl.style.display = 'none';
        this.listEl.innerHTML = '';
        this.items = [];
        this.activeIndex = -1;
    }

    private pick(name: string): void {
        if (!name) return;
        this.close();
        this.onPick(name);
    }

    private onKeydown(e: KeyboardEvent): void {
        if (!this.isOpen()) return;

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const step = e.key === 'ArrowDown' ? 1 : -1;
            this.activeIndex = (this.activeIndex + step + this.items.length) % this.items.length;
            this.render();
        } else if (e.key === 'Enter') {
            // Consume the Enter: pick the highlighted suggestion instead of
            // submitting the raw input text.
            if (this.activeIndex >= 0) {
                e.preventDefault();
                e.stopImmediatePropagation();
                this.pick(this.items[this.activeIndex]);
            }
        } else if (e.key === 'Escape') {
            // Dismiss only the dropdown - not the surrounding modal (the
            // ModalManager listens for Escape at the document level).
            e.preventDefault();
            e.stopPropagation();
            this.close();
        }
    }

    private render(): void {
        if (this.items.length === 0) {
            this.close();
            return;
        }
        this.listEl.innerHTML = this.items.map((name, i) => `
            <div class="create-log-suggest-item ${i === this.activeIndex ? 'active' : ''}"
                 data-suggest="${escapeHtml(name)}">${escapeHtml(name)}</div>`).join('');
        this.listEl.style.display = '';
    }
}
