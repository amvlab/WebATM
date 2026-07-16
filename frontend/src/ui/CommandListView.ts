/**
 * CommandListView — search-list renderer used by `CommandPaletteModal`
 * (Ctrl+K / "Commands" console button). Owns the search input,
 * favorites/recents sections, the filtered "All commands" list, and
 * selection wiring.
 */

import type { StateManager } from '../core/StateManager';
import type { Console } from './Console';
import type { CommandDict } from '../data/types';
import { scoreCommand, getDisplaySignature, LOCAL_COMMAND_SIGNATURES } from '../data/CommandSignature';
import { storage } from '../utils/StorageManager';
import { logger } from '../utils/Logger';

const FAVORITES_KEY = 'cmd-palette-favorites';
const RECENTS_KEY = 'cmd-palette-recents';
const RECENTS_MAX = 20;
const ALL_LIST_LIMIT = 200;

export interface CommandListViewOptions {
    /** Container that will hold the search input + scroll list. */
    container: HTMLElement;
    stateManager: StateManager;
    console: Console;
    /** Optional callback fired after a command is inserted (used by modal to close). */
    onSelect?: (commandName: string) => void;
    /** Placeholder text for the search input. */
    placeholder?: string;
}

export class CommandListView {
    private readonly container: HTMLElement;
    private readonly stateManager: StateManager;
    private readonly consoleRef: Console;
    private readonly onSelect?: (commandName: string) => void;
    private readonly placeholder: string;

    private searchInput!: HTMLInputElement;
    private listElement!: HTMLDivElement;
    private query = '';
    private cmddict: CommandDict | null = null;
    private favorites: string[] = [];
    private recents: string[] = [];
    private unsubscribe: (() => void) | null = null;

    constructor(options: CommandListViewOptions) {
        this.container = options.container;
        this.stateManager = options.stateManager;
        this.consoleRef = options.console;
        this.onSelect = options.onSelect;
        this.placeholder = options.placeholder ?? 'Search commands…';

        this.favorites = storage.get<string[]>(FAVORITES_KEY, []) ?? [];
        this.recents = storage.get<string[]>(RECENTS_KEY, []) ?? [];

        this.build();
        this.cmddict = this.stateManager.getCommandDict();
        this.unsubscribe = this.stateManager.subscribe('cmddict', (next) => {
            this.cmddict = next;
            this.render();
        });

        this.render();
    }

    /** Move keyboard focus to the search input and select existing text. */
    public focusSearch(): void {
        this.searchInput.focus();
        this.searchInput.select();
    }

    /**
     * Refresh the recents section from storage. The Console writes to the
     * same key, so we reread on demand (e.g. each time the modal opens).
     */
    public refreshRecents(): void {
        this.recents = storage.get<string[]>(RECENTS_KEY, []) ?? [];
        this.render();
    }

    /** Detach state subscription. Safe to call more than once. */
    public destroy(): void {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        this.container.innerHTML = '';
    }

    private build(): void {
        this.container.classList.add('command-list-view');
        this.container.innerHTML = '';

        const searchRow = document.createElement('div');
        searchRow.className = 'cmd-search-row';

        this.searchInput = document.createElement('input');
        this.searchInput.type = 'text';
        this.searchInput.className = 'cmd-search-input';
        this.searchInput.placeholder = this.placeholder;
        this.searchInput.autocomplete = 'off';
        this.searchInput.spellcheck = false;
        this.searchInput.addEventListener('input', () => {
            this.query = this.searchInput.value;
            this.render();
        });
        this.searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const first = this.listElement.querySelector<HTMLElement>(
                    '.cmd-row[data-command]'
                );
                if (first) {
                    const cmd = first.dataset.command;
                    if (cmd) this.selectCommand(cmd);
                }
            }
        });
        searchRow.appendChild(this.searchInput);

        this.listElement = document.createElement('div');
        this.listElement.className = 'cmd-list';

        this.container.appendChild(searchRow);
        this.container.appendChild(this.listElement);
    }

    /**
     * The dictionary the palette renders: WebATM's client-side commands
     * (PAN, SWRAD, SHOW*, ...) merged with the server's cmddict, which wins
     * on name collisions. Available even before the server list arrives.
     */
    private effectiveDict(): CommandDict {
        return { ...LOCAL_COMMAND_SIGNATURES, ...(this.cmddict ?? {}) };
    }

    private render(): void {
        const dict = this.effectiveDict();
        const allNames = Object.keys(dict).sort();
        if (allNames.length === 0) {
            this.listElement.innerHTML =
                '<div class="cmd-empty">No commands available.</div>';
            return;
        }

        this.listElement.innerHTML = '';

        if (!this.query) {
            this.renderSection('Favorites', this.filterExisting(this.favorites));
            this.renderSection('Recent', this.filterExisting(this.recents));
            this.renderSection('All commands', allNames, ALL_LIST_LIMIT);
            if (!this.cmddict) {
                const waiting = document.createElement('div');
                waiting.className = 'cmd-empty';
                waiting.textContent = 'Waiting for command list from server…';
                this.listElement.appendChild(waiting);
            }
            return;
        }

        // Score every command against the query and sort best-first.
        const scored: Array<{ name: string; score: number }> = [];
        for (const name of allNames) {
            const sig = dict[name] ?? '';
            const s = scoreCommand(this.query, name, sig);
            if (s !== null) scored.push({ name, score: s });
        }
        scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));

        if (scored.length === 0) {
            this.listElement.innerHTML =
                '<div class="cmd-empty">No matching commands.</div>';
            return;
        }

        this.renderSection(
            `Results (${scored.length})`,
            scored.map(s => s.name),
            ALL_LIST_LIMIT
        );
    }

    /** Drop favorite/recent entries that aren't in the current dictionary. */
    private filterExisting(names: string[]): string[] {
        const dict = this.effectiveDict();
        return names.filter(n => Object.prototype.hasOwnProperty.call(dict, n));
    }

    private renderSection(
        title: string,
        names: string[],
        limit?: number
    ): void {
        if (names.length === 0) return;

        const header = document.createElement('div');
        header.className = 'cmd-section-header';
        header.textContent = title;
        this.listElement.appendChild(header);

        const sliced = limit ? names.slice(0, limit) : names;
        for (const name of sliced) {
            this.listElement.appendChild(this.buildRow(name));
        }

        if (limit && names.length > limit) {
            const more = document.createElement('div');
            more.className = 'cmd-empty';
            more.textContent = `…and ${names.length - limit} more — refine your search`;
            this.listElement.appendChild(more);
        }
    }

    private buildRow(name: string): HTMLElement {
        const rawSig = this.effectiveDict()[name] ?? '';
        // Show the user-facing signature in the palette row so commands like
        // MCRE don't advertise lat/lon args that CommandHandler injects.
        const sig = getDisplaySignature(name, rawSig);

        const row = document.createElement('div');
        row.className = 'cmd-row';
        row.dataset.command = name;

        const star = document.createElement('button');
        star.type = 'button';
        star.className = 'cmd-fav';
        const isFav = this.favorites.includes(name);
        star.classList.toggle('active', isFav);
        star.textContent = isFav ? '★' : '☆';
        star.title = isFav ? 'Remove from favorites' : 'Add to favorites';
        star.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleFavorite(name);
        });

        const nameSpan = document.createElement('span');
        nameSpan.className = 'cmd-name';
        nameSpan.textContent = name;

        const sigSpan = document.createElement('span');
        sigSpan.className = 'cmd-sig';
        sigSpan.textContent = sig || '(no arguments)';

        row.appendChild(star);
        row.appendChild(nameSpan);
        row.appendChild(sigSpan);

        row.addEventListener('click', () => this.selectCommand(name));

        return row;
    }

    private toggleFavorite(name: string): void {
        const idx = this.favorites.indexOf(name);
        if (idx >= 0) {
            this.favorites.splice(idx, 1);
        } else {
            this.favorites.push(name);
            this.favorites.sort();
        }
        const ok = storage.set(FAVORITES_KEY, this.favorites);
        if (!ok) logger.warn('CommandListView', 'Failed to persist favorites');
        this.render();
    }

    private selectCommand(name: string): void {
        this.consoleRef.setInputValue(name + ' ');
        if (this.onSelect) this.onSelect(name);
    }

    /**
     * Public helper so other code (e.g. Console after a successful send) can
     * push a command into the recents list. Cap at RECENTS_MAX, dedupe by
     * moving an existing entry to the front.
     */
    public static recordRecent(name: string): void {
        if (!name) return;
        const upper = name.toUpperCase();
        const current = storage.get<string[]>(RECENTS_KEY, []) ?? [];
        const next = [upper, ...current.filter(n => n !== upper)].slice(
            0,
            RECENTS_MAX
        );
        storage.set(RECENTS_KEY, next);
    }
}
