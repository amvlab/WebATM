import { Dropdown } from '../utils/dropdown';
import { OPENAP_AIRCRAFT_TYPES } from '../data/aircraftTypes';
import { parseSignature, getDisplaySignature } from '../data/CommandSignature';
import { getArgAtCursor, findAcidContext, AcidContext } from './consoleTokens';
import type { CommandDict } from '../data/types';

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
     * Called after a suggestion is inserted so the console can refresh
     * its ghost suggestion and map picker for the new input value.
     */
    onAfterSelect: () => void;
}

/**
 * ConsoleAutocomplete - the ACID and aircraft-type dropdowns attached to
 * the console input, extracted from Console.
 *
 * Owns two cmddict-aware autocompletes:
 * - ACID: suggests existing aircraft IDs whenever the cursor sits on an
 *   acid-parameter slot. For CRE/MCRE it instead warns when the typed ID
 *   already exists.
 * - Aircraft type: suggests openap types on the type slot of CRE/MCRE,
 *   warning when a non-openap type is being entered.
 */
export class ConsoleAutocomplete {
    private readonly aircraftTypes: string[] = [...OPENAP_AIRCRAFT_TYPES];

    private acidDropdown: Dropdown<string> | null = null;
    private acidWarning: HTMLDivElement | null = null;

    private typeDropdown: Dropdown<string> | null = null;
    private typeWarning: HTMLDivElement | null = null;

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
    }

    /**
     * Let a visible dropdown consume a keydown (arrows/Enter). The type
     * dropdown gets first refusal, matching the original console order.
     * Returns true when the key was handled.
     */
    public handleKey(key: string): boolean {
        if (this.typeDropdown?.handleKey(key)) return true;
        return this.acidDropdown?.handleKey(key) ?? false;
    }

    /** Refresh both autocompletes for the current input value and cursor. */
    public update(): void {
        this.updateAcidAutocomplete();
        this.updateTypeAutocomplete();
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
}
