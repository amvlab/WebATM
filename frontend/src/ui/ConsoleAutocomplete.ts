import { Dropdown } from '../utils/dropdown';
import { OPENAP_AIRCRAFT_TYPES } from '../data/aircraftTypes';
import { parseSignature, getDisplaySignature } from '../data/CommandSignature';
import { getArgAtCursor, findAcidContext, findPanContext, AcidContext } from './consoleTokens';
import type { CommandDict } from '../data/types';
import type { NavdataSearchResult } from '../data/navdataSearch';

/**
 * One entry in the PAN destination dropdown: an aircraft currently in the
 * simulation, or an airport/heliport/waypoint from the navdata index.
 */
export interface PanSuggestion {
    kind: 'aircraft' | NavdataSearchResult['kind'];
    ident: string;
    /** Human-readable name (navdata results only). */
    name?: string;
}

/** Badge text shown next to each PAN suggestion, keyed by kind. */
const PAN_KIND_BADGES: Record<PanSuggestion['kind'], string> = {
    aircraft: 'AC',
    airport: 'APT',
    heliport: 'HEL',
    waypoint: 'WPT',
};

/** Cap per source so the merged PAN dropdown stays scannable. */
const PAN_MAX_AIRCRAFT = 6;
const PAN_MAX_NAVDATA = 6;

/** Debounce for navdata searches while the user types a PAN argument. */
const PAN_SEARCH_DEBOUNCE_MS = 200;

/**
 * Rank candidates for an autocomplete slot: case-insensitive prefix matches
 * first, then substring matches. An empty query returns the full list.
 */
function rankByPrefixThenContains(items: string[], upperPartial: string): string[] {
    if (upperPartial.length === 0) return [...items];
    const startsWith = items.filter(x => x.toUpperCase().startsWith(upperPartial));
    const contains = items.filter(
        x => !x.toUpperCase().startsWith(upperPartial) && x.toUpperCase().includes(upperPartial)
    );
    return [...startsWith, ...contains];
}

/**
 * True when `filtered` holds exactly the value already typed and the cursor
 * sits at end-of-input — the slot is complete, so the dropdown should get out
 * of the way. Stays open mid-input so an earlier slot can still be swapped.
 */
function isCompletedSlot(filtered: string[], upperPartial: string, isMidInput: boolean): boolean {
    return !isMidInput && filtered.length === 1 && filtered[0].toUpperCase() === upperPartial;
}

/**
 * Dependencies the autocomplete needs from the console. Provided as
 * closures so the autocomplete stays decoupled from Console/StateManager
 * construction order.
 */
export interface ConsoleAutocompleteDeps {
    /** Current command dictionary from the server, when loaded. */
    getCommandDict: () => CommandDict | null;
    /** Aircraft IDs currently in the simulation. */
    getAircraftIds: () => string[];
    /**
     * Search the navdata index (airports/heliports/waypoints) for the PAN
     * dropdown. Should resolve to [] when the index is unavailable.
     */
    searchNavdata: (query: string) => Promise<NavdataSearchResult[]>;
    /**
     * Called after a suggestion is inserted so the console can refresh
     * its ghost suggestion and map picker for the new input value.
     */
    onAfterSelect: () => void;
}

/**
 * ConsoleAutocomplete - the ACID and aircraft-type dropdowns attached to
 * the console input, extracted from Console.
 *
 * Owns three cmddict-aware autocompletes:
 * - ACID: suggests existing aircraft IDs whenever the cursor sits on an
 *   acid-parameter slot. For CRE/MCRE it instead warns when the typed ID
 *   already exists.
 * - Aircraft type: suggests openap types on the type slot of CRE/MCRE,
 *   warning when a non-openap type is being entered.
 * - PAN destination: on PAN's first argument, suggests aircraft first and
 *   then airports/waypoints from the navdata index, each labeled with a
 *   kind badge (AC/APT/HEL/WPT) since the slot accepts all of them.
 */
export class ConsoleAutocomplete {
    private readonly aircraftTypes: string[] = [...OPENAP_AIRCRAFT_TYPES];

    private acidDropdown: Dropdown<string> | null = null;
    private acidWarning: HTMLDivElement | null = null;

    private typeDropdown: Dropdown<string> | null = null;
    private typeWarning: HTMLDivElement | null = null;

    private panDropdown: Dropdown<PanSuggestion> | null = null;
    private panDebounceTimer: number | null = null;
    /** Monotonic counter that invalidates in-flight navdata searches. */
    private panSearchSeq = 0;

    constructor(private readonly deps: ConsoleAutocompleteDeps) {}

    /**
     * Create the dropdown and warning elements inside the console input
     * container. Call once the DOM is ready.
     */
    public createElements(): void {
        const inputContainer = document.querySelector('.console-input-container');
        if (!inputContainer) return;

        this.acidDropdown = new Dropdown<string>({
            container: inputContainer as HTMLElement,
            rootClass: 'acid-autocomplete-dropdown',
            itemClass: 'acid-dropdown-item',
            renderItem: (id) => id,
            onSelect: (_id, index) => this.selectAcidSuggestion(index)
        });

        this.acidWarning = document.createElement('div');
        this.acidWarning.className = 'acid-warning';
        this.acidWarning.style.display = 'none';
        inputContainer.appendChild(this.acidWarning);

        this.typeDropdown = new Dropdown<string>({
            container: inputContainer as HTMLElement,
            rootClass: 'actype-autocomplete-dropdown',
            itemClass: 'actype-dropdown-item',
            renderItem: (type) => type,
            onSelect: (_type, index) => this.selectTypeSuggestion(index)
        });

        this.typeWarning = document.createElement('div');
        this.typeWarning.className = 'actype-warning';
        this.typeWarning.style.display = 'none';
        inputContainer.appendChild(this.typeWarning);

        this.panDropdown = new Dropdown<PanSuggestion>({
            container: inputContainer as HTMLElement,
            rootClass: 'pan-autocomplete-dropdown',
            itemClass: 'pan-dropdown-item',
            renderItem: (s) => this.renderPanSuggestion(s),
            onSelect: (_s, index) => this.selectPanSuggestion(index)
        });
    }

    /**
     * Let a visible dropdown consume a keydown (arrows/Enter). The type
     * dropdown gets first refusal, matching the original console order.
     * Returns true when the key was handled.
     */
    public handleKey(key: string): boolean {
        if (this.typeDropdown?.handleKey(key)) return true;
        if (this.acidDropdown?.handleKey(key)) return true;
        return this.panDropdown?.handleKey(key) ?? false;
    }

    /** Refresh all autocompletes for the current input value and cursor. */
    public update(): void {
        this.updateAcidAutocomplete();
        this.updateTypeAutocomplete();
        this.updatePanAutocomplete();
    }

    /**
     * Hide the dropdowns and the type warning. Used on Escape and blur;
     * intentionally leaves the ACID duplicate warning visible since it
     * reflects the typed value, not transient navigation state.
     */
    public hideTransient(): void {
        this.hideAcidDropdown();
        this.hideTypeDropdown();
        this.hideTypeWarning();
        this.hidePanDropdown();
    }

    /** Hide every dropdown and warning. Used when the input is cleared. */
    public hideAll(): void {
        this.hideTransient();
        this.hideAcidWarning();
    }

    private getInput(): HTMLInputElement | null {
        return document.getElementById('console-input') as HTMLInputElement | null;
    }

    /**
     * Read the console input's current cursor position, falling back to
     * the end of the value when the selection API returns null.
     */
    private getCursorPos(input: HTMLInputElement): number {
        return input.selectionStart ?? input.value.length;
    }

    /**
     * Locate an acid-parameter slot at the cursor using the current
     * cmddict (see consoleTokens.findAcidContext).
     */
    private getAcidContext(value: string, cursorPos: number): AcidContext | null {
        return findAcidContext(value, cursorPos, this.deps.getCommandDict());
    }

    /**
     * Update the ACID autocomplete dropdown based on current input
     */
    private updateAcidAutocomplete(): void {
        const input = this.getInput();
        if (!input) return;

        const value = input.value;
        if (!value.trim()) {
            this.hideAcidDropdown();
            this.hideAcidWarning();
            return;
        }

        const context = this.getAcidContext(value, this.getCursorPos(input));
        if (!context) {
            this.hideAcidDropdown();
            this.hideAcidWarning();
            return;
        }

        const { partialAcid, isCreCommand, isMidInput } = context;
        const allIds = this.deps.getAircraftIds();

        if (isCreCommand) {
            // For CRE/MCRE: don't autocomplete, but warn if acid exists
            this.hideAcidDropdown();
            if (partialAcid.length > 0) {
                const upperPartial = partialAcid.toUpperCase();
                const exists = allIds.some(id => id.toUpperCase() === upperPartial);
                if (exists) {
                    this.showAcidWarning(`Aircraft "${partialAcid.toUpperCase()}" already exists`);
                } else {
                    this.hideAcidWarning();
                }
            } else {
                this.hideAcidWarning();
            }
            return;
        }

        // For non-CRE commands: show autocomplete dropdown
        this.hideAcidWarning();

        if (allIds.length === 0) {
            this.hideAcidDropdown();
            return;
        }

        const upperPartial = partialAcid.toUpperCase();
        const filtered = rankByPrefixThenContains(allIds, upperPartial);

        if (filtered.length === 0) {
            this.hideAcidDropdown();
            return;
        }

        if (isCompletedSlot(filtered, upperPartial, isMidInput)) {
            this.hideAcidDropdown();
            return;
        }

        this.acidDropdown?.setItems(filtered);
    }

    /**
     * Select an ACID suggestion and insert it into the input
     */
    private selectAcidSuggestion(index: number): void {
        const input = this.getInput();
        const items = this.acidDropdown?.getItems() ?? [];
        if (!input || index < 0 || index >= items.length) return;

        const selectedId = items[index];
        this.replaceTokenAtCursor(input, selectedId);

        this.hideAcidDropdown();
        input.focus();
        this.deps.onAfterSelect();
    }

    /**
     * Replace the argument token under the cursor with `replacement`. When the
     * cursor is at end-of-input the replacement is followed by a space so the
     * user can keep typing the next argument; mid-input replacements leave
     * whatever followed the token untouched and place the cursor right after
     * the inserted text.
     */
    private replaceTokenAtCursor(input: HTMLInputElement, replacement: string): void {
        const value = input.value;
        const cursorPos = this.getCursorPos(input);
        const { tokenStart, tokenEnd } = getArgAtCursor(value, cursorPos);

        const before = value.substring(0, tokenStart);
        const after = value.substring(tokenEnd);
        const atEnd = after.length === 0;

        const newValue = atEnd
            ? before + replacement + ' '
            : before + replacement + after;
        const newCursor = tokenStart + replacement.length + (atEnd ? 1 : 0);

        input.value = newValue;
        input.setSelectionRange(newCursor, newCursor);
    }

    private hideAcidDropdown(): void {
        this.acidDropdown?.hide();
    }

    /**
     * Show the CRE duplicate aircraft warning
     */
    private showAcidWarning(message: string): void {
        if (!this.acidWarning) return;
        this.acidWarning.textContent = message;
        this.acidWarning.style.display = 'block';
    }

    private hideAcidWarning(): void {
        if (this.acidWarning) {
            this.acidWarning.style.display = 'none';
        }
    }

    /**
     * Check if the cursor sits on the aircraft-type parameter of a CRE/MCRE
     * command. Returns the partial type being typed when applicable.
     */
    private getTypeContext(value: string, cursorPos: number): { partialType: string; isMidInput: boolean } | null {
        const { currentArgIndex, partialText, tokenEnd, parts } = getArgAtCursor(value, cursorPos);
        if (parts.length < 1) return null;

        const isMidInput = value.substring(tokenEnd).trim().length > 0;

        const command = parts[0].toUpperCase();
        if (command !== 'CRE' && command !== 'MCRE') return null;

        // Look up the parameter list from cmddict so we follow whatever
        // argument order the server advertises.
        const rawParamString = this.deps.getCommandDict()?.[command];
        if (!rawParamString) return null;

        // Use the user-facing signature so MCRE's `type` arg lines up at
        // the position the user actually types it (right after `n`).
        const paramString = getDisplaySignature(command, rawParamString);
        const params = parseSignature(paramString).map(arg => arg.name);

        if (currentArgIndex < 0 || currentArgIndex >= params.length) return null;

        const currentParam = params[currentArgIndex];
        const typeParamNames = ['type', 'actype'];
        if (!typeParamNames.includes(currentParam)) return null;

        return { partialType: partialText, isMidInput };
    }

    /**
     * Update the aircraft type autocomplete dropdown based on current input
     */
    private updateTypeAutocomplete(): void {
        const input = this.getInput();
        if (!input) return;

        const value = input.value;
        if (!value.trim()) {
            this.hideTypeDropdown();
            this.hideTypeWarning();
            return;
        }

        const context = this.getTypeContext(value, this.getCursorPos(input));
        if (!context) {
            this.hideTypeDropdown();
            this.hideTypeWarning();
            return;
        }

        const { partialType, isMidInput } = context;
        const upperPartial = partialType.toUpperCase();

        const filtered = rankByPrefixThenContains(this.aircraftTypes, upperPartial);

        if (filtered.length === 0) {
            // Non-openap type being typed - hide the dropdown so the user
            // can enter a custom type without interference, but show an
            // inline warning (mirrors the Create Aircraft modal).
            this.hideTypeDropdown();
            this.showTypeWarning(
                `openap library does not include "${upperPartial}"`
            );
            return;
        }

        if (isCompletedSlot(filtered, upperPartial, isMidInput)) {
            this.hideTypeDropdown();
            this.hideTypeWarning();
            return;
        }

        // Partial matches exist - user is still typing a valid openap type.
        this.hideTypeWarning();

        this.typeDropdown?.setItems(filtered);
    }

    /**
     * Select a type suggestion and insert it into the input
     */
    private selectTypeSuggestion(index: number): void {
        const input = this.getInput();
        const items = this.typeDropdown?.getItems() ?? [];
        if (!input || index < 0 || index >= items.length) return;

        const selectedType = items[index];
        this.replaceTokenAtCursor(input, selectedType);

        this.hideTypeDropdown();
        input.focus();
        this.deps.onAfterSelect();
    }

    private hideTypeDropdown(): void {
        this.typeDropdown?.hide();
    }

    /**
     * Show the openap aircraft type warning with the given message
     */
    private showTypeWarning(message: string): void {
        if (!this.typeWarning) return;
        this.typeWarning.textContent = message;
        this.typeWarning.style.display = 'block';
    }

    private hideTypeWarning(): void {
        if (this.typeWarning) {
            this.typeWarning.style.display = 'none';
        }
    }

    /**
     * Update the PAN destination dropdown based on current input.
     *
     * Aircraft matches render immediately (they're already in memory);
     * airport/waypoint matches from the navdata index are fetched on a
     * debounce and appended below the aircraft when they arrive.
     */
    private updatePanAutocomplete(): void {
        const input = this.getInput();
        if (!input) return;

        const value = input.value;
        const context = value.trim()
            ? findPanContext(value, this.getCursorPos(input))
            : null;
        if (!context) {
            this.hidePanDropdown();
            return;
        }

        this.cancelPanSearch();
        const { partialQuery, isMidInput } = context;
        const upperPartial = partialQuery.toUpperCase();

        const aircraft: PanSuggestion[] = rankByPrefixThenContains(
            this.deps.getAircraftIds(), upperPartial
        )
            .slice(0, PAN_MAX_AIRCRAFT)
            .map(id => ({ kind: 'aircraft', ident: id }));

        this.showPanSuggestions(aircraft, upperPartial, isMidInput);

        // Navdata needs at least one character to search on.
        if (partialQuery.length === 0) return;

        const seq = this.panSearchSeq;
        this.panDebounceTimer = window.setTimeout(() => {
            this.panDebounceTimer = null;
            void this.deps.searchNavdata(partialQuery)
                .catch(() => [] as NavdataSearchResult[])
                .then(results => {
                    if (seq !== this.panSearchSeq) return; // superseded
                    const navaids: PanSuggestion[] = results
                        .slice(0, PAN_MAX_NAVDATA)
                        .map(r => ({ kind: r.kind, ident: r.ident, name: r.name }));
                    this.showPanSuggestions(
                        [...aircraft, ...navaids], upperPartial, isMidInput
                    );
                });
        }, PAN_SEARCH_DEBOUNCE_MS);
    }

    /**
     * Render the merged PAN suggestion list, hiding the dropdown when it is
     * empty or when the slot already holds the single remaining match.
     */
    private showPanSuggestions(
        items: PanSuggestion[],
        upperPartial: string,
        isMidInput: boolean
    ): void {
        if (items.length === 0) {
            this.panDropdown?.hide();
            return;
        }
        if (isCompletedSlot(items.map(i => i.ident), upperPartial, isMidInput)) {
            this.panDropdown?.hide();
            return;
        }
        this.panDropdown?.setItems(items);
    }

    /**
     * Build the DOM for one PAN suggestion: a kind badge (AC/APT/HEL/WPT),
     * the ident, and - for navdata results - the human-readable name.
     */
    private renderPanSuggestion(s: PanSuggestion): HTMLElement {
        const row = document.createElement('span');
        row.className = 'pan-item';

        const badge = document.createElement('span');
        badge.className = `pan-badge pan-badge-${s.kind}`;
        badge.textContent = PAN_KIND_BADGES[s.kind];
        row.appendChild(badge);

        const ident = document.createElement('span');
        ident.className = 'pan-item-ident';
        ident.textContent = s.ident;
        row.appendChild(ident);

        if (s.name) {
            const name = document.createElement('span');
            name.className = 'pan-item-name';
            name.textContent = s.name;
            row.appendChild(name);
        }
        return row;
    }

    /**
     * Select a PAN suggestion and insert its ident into the input
     */
    private selectPanSuggestion(index: number): void {
        const input = this.getInput();
        const items = this.panDropdown?.getItems() ?? [];
        if (!input || index < 0 || index >= items.length) return;

        this.replaceTokenAtCursor(input, items[index].ident);

        this.hidePanDropdown();
        input.focus();
        this.deps.onAfterSelect();
    }

    /** Cancel any pending/in-flight navdata search for the PAN dropdown. */
    private cancelPanSearch(): void {
        this.panSearchSeq++;
        if (this.panDebounceTimer !== null) {
            window.clearTimeout(this.panDebounceTimer);
            this.panDebounceTimer = null;
        }
    }

    private hidePanDropdown(): void {
        this.cancelPanSearch();
        this.panDropdown?.hide();
    }
}
