import { App } from '../core/App';
import type { StateManager } from '../core/StateManager';
import { storage } from '../utils/StorageManager';
import { CommandHandler } from '../data/CommandHandler';
import { OPENAP_AIRCRAFT_TYPES } from '../data/aircraftTypes';
import { logger } from '../utils/Logger';
import { ConsoleMapPicker, GeoContext } from './ConsoleMapPicker';
import type { MapDisplay } from './map/MapDisplay';
import {
    parseSignature,
    currentArgIndex,
    commandFromInput,
    getDisplaySignature,
    SignatureArg,
} from '../data/CommandSignature';
import { CommandListView } from './CommandListView';

interface AppWindow extends Window {
    app?: App;
    console_ui?: Console;
}

declare const window: AppWindow;

export class Console {
    private history: string[] = [];
    private historyIndex: number | null = null; // null means fresh input line
    private readonly maxHistory: number = 100;
    private readonly aircraftTypes: string[];
    private stateManager: StateManager | null = null;
    private suggestionOverlay: HTMLDivElement | null = null;
    private commandHandler: CommandHandler | null = null;

    // ACID autocomplete state
    private acidDropdown: HTMLDivElement | null = null;
    private acidSuggestions: string[] = [];
    private acidSelectedIndex: number = -1;
    private acidWarning: HTMLDivElement | null = null;

    // Aircraft type autocomplete state
    private typeDropdown: HTMLDivElement | null = null;
    private typeSuggestions: string[] = [];
    private typeSelectedIndex: number = -1;
    private typeWarning: HTMLDivElement | null = null;

    // Map-click picker for lat/lon/hdg arguments
    private mapPicker: ConsoleMapPicker | null = null;

    // Inline argument-signature hint rendered above the input (from cmddict)
    private argHint: HTMLDivElement | null = null;

    constructor() {
        // Aircraft types supported by the openap library (shared constant)
        this.aircraftTypes = [...OPENAP_AIRCRAFT_TYPES];

        // Load command history from localStorage
        this.loadHistory();

        this.init();
    }

    private init(): void {
        this.setupEventListeners();
        this.createSuggestionOverlay();
        this.createArgHint();
        this.createAcidDropdown();
        this.createAcidWarning();
        this.createTypeDropdown();
        this.createTypeWarning();
        this.clearDisplay();
        this.applyPlatformPlaceholder();
    }

    /**
     * Swap the placeholder's "Ctrl+K" hint for "⌘+K" on macOS so the
     * always-visible discoverability clue matches the platform.
     */
    private applyPlatformPlaceholder(): void {
        const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
        if (!isMac) return;
        const input = document.getElementById('console-input') as HTMLInputElement | null;
        if (!input) return;
        input.placeholder = input.placeholder.replace('Ctrl+K', '⌘+K');
    }

    /**
     * Create the argument-signature hint row shown directly above the input.
     *
     * Unlike the inline ghost-text suggestion (which only shows the *remaining*
     * args), this row renders the *full* signature for the typed command and
     * highlights the arg the cursor is currently on. Hidden when the input is
     * empty or the command isn't in cmddict. Sits above the input so it
     * doesn't push the layout down as the user types.
     */
    private createArgHint(): void {
        const inputContainer = document.querySelector('.console-input-container');
        if (!inputContainer || !inputContainer.parentElement) return;

        this.argHint = document.createElement('div');
        this.argHint.className = 'console-arg-hint';
        this.argHint.style.display = 'none';
        // Insert directly before the input container so it appears above it.
        inputContainer.parentElement.insertBefore(this.argHint, inputContainer);
    }

    /**
     * Set state manager reference to access command dictionary
     */
    public setStateManager(stateManager: StateManager): void {
        this.stateManager = stateManager;
    }

    /**
     * Set command handler reference for processing local commands
     */
    public setCommandHandler(commandHandler: CommandHandler): void {
        this.commandHandler = commandHandler;
    }

    /**
     * Provide a MapDisplay reference so the console can offer map-click
     * coordinate/heading insertion while the user types a command.
     */
    public setMapDisplay(mapDisplay: MapDisplay): void {
        this.mapPicker = new ConsoleMapPicker(mapDisplay, this);
    }

    /**
     * Create suggestion overlay element
     */
    private createSuggestionOverlay(): void {
        const inputContainer = document.querySelector('.console-input-container');
        if (!inputContainer) {
            console.error('[Console] Console input container not found');
            return;
        }

        this.suggestionOverlay = document.createElement('div');
        this.suggestionOverlay.className = 'console-suggestion-overlay';
        this.suggestionOverlay.style.display = 'none';
        inputContainer.appendChild(this.suggestionOverlay);
    }

    /**
     * Load command history from localStorage
     */
    private loadHistory(): void {
        const savedHistory = storage.get<string[]>('console-command-history', []);
        if (savedHistory && Array.isArray(savedHistory)) {
            this.history = savedHistory;
            logger.info('Console', `Loaded ${this.history.length} commands from history`);
        }
    }

    /**
     * Save command history to localStorage
     */
    private saveHistory(): void {
        storage.set('console-command-history', this.history);
    }

    /**
     * Clear the console display (but preserve history)
     */
    private clearDisplay(): void {
        const output = document.getElementById('console-output');
        if (output) {
            output.innerHTML = '';
        }
    }

    private setupEventListeners(): void {
        const input = document.getElementById('console-input') as HTMLInputElement;
        if (!input) {
            console.error('[Console] Console input element not found');
            return;
        }

        // Handle arrow keys for command history and ACID/type dropdowns
        input.addEventListener('keydown', (e: KeyboardEvent) => {
            // Let dropdowns handle keys first when visible
            if (this.handleTypeDropdownKey(e.key)) {
                e.preventDefault();
                return;
            }
            if (this.handleAcidDropdownKey(e.key)) {
                e.preventDefault();
                return;
            }

            switch (e.key) {
                case 'ArrowUp':
                    e.preventDefault();
                    this.showPreviousCommand();
                    this.updateSuggestion();
                    this.updateArgHint();
                    this.updateMapPicker();
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    this.showNextCommand();
                    this.updateSuggestion();
                    this.updateArgHint();
                    this.updateMapPicker();
                    break;
                case 'Tab':
                    e.preventDefault();
                    this.autoComplete();
                    this.updateSuggestion();
                    this.updateArgHint();
                    this.updateMapPicker();
                    break;
                case 'Enter':
                    this.handleCommand(input.value);
                    this.addToHistory(input.value);
                    this.resetInput();
                    break;
                case 'Escape':
                    this.hideAcidDropdown();
                    this.hideTypeDropdown();
                    this.hideTypeWarning();
                    this.mapPicker?.disable();
                    break;
            }
        });

        // Update suggestion and ACID/type autocomplete as user types
        input.addEventListener('input', () => {
            this.updateSuggestion();
            this.updateArgHint();
            this.updateAcidAutocomplete();
            this.updateTypeAutocomplete();
            this.updateMapPicker();
        });

        // Refresh dropdowns when the cursor moves without a text change, so
        // clicking back into an earlier token (or navigating with the arrow
        // keys / Home / End) re-opens that slot's dropdown.
        const refreshForCursor = () => {
            this.updateArgHint();
            this.updateAcidAutocomplete();
            this.updateTypeAutocomplete();
            this.updateMapPicker();
        };
        input.addEventListener('click', refreshForCursor);
        input.addEventListener('keyup', (e: KeyboardEvent) => {
            if (
                e.key === 'ArrowLeft' ||
                e.key === 'ArrowRight' ||
                e.key === 'Home' ||
                e.key === 'End'
            ) {
                refreshForCursor();
            }
        });
        input.addEventListener('focus', refreshForCursor);

        // Hide dropdowns when input loses focus
        input.addEventListener('blur', () => {
            // Small delay to allow mousedown on dropdown items to fire
            setTimeout(() => {
                this.hideAcidDropdown();
                this.hideTypeDropdown();
                this.hideTypeWarning();
            }, 150);
        });

        // Handle clear console button
        const clearButton = document.getElementById('clear-console');
        if (clearButton) {
            clearButton.addEventListener('click', () => {
                this.clear();
            });
        }
    }

    /**
     * Get all available commands (merged from CommandHandler + cmddict)
     */
    private getAllCommands(): string[] {
        const allCommands = new Set<string>();

        // Add local/preprocessed commands from CommandHandler (single source of truth)
        if (this.commandHandler) {
            this.commandHandler.getAllHandledCommands().forEach(cmd => allCommands.add(cmd));
        }

        // Merge commands from BlueSky cmddict if available
        if (this.stateManager) {
            const cmddict = this.stateManager.getCommandDict();
            if (cmddict) {
                Object.keys(cmddict).forEach(cmd => allCommands.add(cmd));
            }
        }

        return Array.from(allCommands).sort();
    }

    private autoComplete(): void {
        const input = document.getElementById('console-input') as HTMLInputElement;
        if (!input) return;

        const value = input.value;

        // Don't autocomplete empty input
        if (!value.trim()) return;

        const words = value.split(' ');
        const currentWord = words[words.length - 1].toUpperCase();

        let suggestions: string[] = [];

        if (words.length === 1) {
            // Complete command - use merged command list
            const allCommands = this.getAllCommands();

            // Only filter if there's something to match
            if (currentWord.length > 0) {
                suggestions = allCommands.filter(cmd =>
                    cmd.startsWith(currentWord)
                );
            }
        } else if (words.length > 1) {
            // Complete aircraft type for CRE/MCRE commands.
            // CRE acid, type, lat, lon, hdg, alt, spd  -> type is the 2nd argument
            // MCRE count, type, alt, spd, dest         -> type is also the 2nd argument
            const cmd = words[0].toUpperCase();
            if ((cmd === 'CRE' || cmd === 'MCRE') && words.length === 3 && currentWord.length > 0) {
                suggestions = this.aircraftTypes.filter(type =>
                    type.startsWith(currentWord)
                );
            }
        }

        if (suggestions.length === 1) {
            // Single match - complete it
            words[words.length - 1] = suggestions[0];
            input.value = words.join(' ');

            // Move cursor to end
            input.setSelectionRange(input.value.length, input.value.length);
        } else if (suggestions.length > 1) {
            // Multiple matches - show them in console
            this.showSuggestions(suggestions);
        }
    }

    private showSuggestions(suggestions: string[]): void {
        const output = document.getElementById('console-output');
        if (!output) return;

        const line = document.createElement('div');
        line.className = 'console-line';
        line.textContent = 'Suggestions: ' + suggestions.join(', ');
        output.appendChild(line);
        output.scrollTop = output.scrollHeight;
    }

    private handleCommand(command: string): void {
        if (!command.trim()) return;

        // Display the command in the console
        this.addMessage('> ' + command, 'command');

        // Also push the command name into the palette's "recents" list so
        // recently-used commands surface at the top of the searchable list.
        const cmdName = commandFromInput(command);
        if (cmdName) {
            CommandListView.recordRecent(cmdName);
        }

        // Process command through CommandHandler first
        if (this.commandHandler) {
            const result = this.commandHandler.handleCommand(command);

            // If command was handled locally or shouldn't be sent to server, return
            // (CommandHandler sends messages to echo directly)
            if (result.handled && !result.sendToServer) {
                return;
            }

            // If command needs to be modified before sending, use modified version
            if (result.sendToServer && result.modifiedCommand) {
                if (window.app) {
                    window.app.sendCommand(result.modifiedCommand);
                }
                return;
            }

            // If handler says to send to server but didn't handle it, fall through
            if (!result.handled && result.sendToServer) {
                if (window.app) {
                    window.app.sendCommand(command);
                }
                return;
            }
        }

        // Fallback: send command through main app if no handler
        if (window.app) {
            window.app.sendCommand(command);
        }
    }

    private addToHistory(command: string): void {
        if (!command.trim()) return;

        // Add to end of history (newest commands at the end)
        this.history.push(command);

        // Limit history size
        if (this.history.length > this.maxHistory) {
            this.history.shift(); // Remove oldest command
        }

        // Save history to localStorage
        this.saveHistory();

        // Also add to app.js history to keep them in sync
        if (window.app && window.app.addToHistory) {
            window.app.addToHistory(command);
        }
    }

    private showPreviousCommand(): void {
        if (this.history.length === 0) return;

        const input = document.getElementById('console-input') as HTMLInputElement;
        if (!input) return;

        // If we're at fresh input state, go to newest command
        if (this.historyIndex === null) {
            this.historyIndex = this.history.length - 1;
        } else if (this.historyIndex > 0) {
            // Move to older command
            this.historyIndex--;
        }
        // If already at oldest command, do nothing (no cycling)

        input.value = this.history[this.historyIndex];
    }

    private showNextCommand(): void {
        const input = document.getElementById('console-input') as HTMLInputElement;
        if (!input) return;

        // If no history or at fresh input state, do nothing
        if (this.history.length === 0 || this.historyIndex === null) {
            return;
        }

        // Move to newer command
        if (this.historyIndex < this.history.length - 1) {
            this.historyIndex++;
            input.value = this.history[this.historyIndex];
        } else {
            // At newest command, go back to fresh input
            this.historyIndex = null;
            input.value = '';
        }
    }

    public addMessage(message: string, className: string = ''): void {
        const output = document.getElementById('console-output');
        if (!output) return;

        const line = document.createElement('div');
        line.className = 'console-line ' + className;
        line.textContent = message;
        output.appendChild(line);
        output.scrollTop = output.scrollHeight;
    }

    public clear(): void {
        const output = document.getElementById('console-output');
        if (output) {
            output.innerHTML = '';
        }
    }

    /**
     * Get console instance for global access
     */
    public getConsole(): Console {
        return this;
    }

    /**
     * Display a command that was sent (e.g., from modals or UI interactions)
     * This adds the command to the console output and history
     */
    public displaySentCommand(command: string): void {
        logger.debug('Console', 'displaySentCommand called with:', command);

        if (!command.trim()) {
            logger.debug('Console', 'Command is empty, returning');
            return;
        }

        // Display the command in the console with command styling
        logger.debug('Console', 'Adding message to console output');
        this.addMessage('> ' + command, 'command');

        // Add to history so it can be recalled with arrow keys
        logger.debug('Console', 'Adding command to history');
        this.addToHistory(command);

        logger.debug('Console', 'displaySentCommand completed');
    }

    /**
     * Update command parameter suggestion based on current input
     */
    private updateSuggestion(): void {
        const input = document.getElementById('console-input') as HTMLInputElement;
        if (!input || !this.suggestionOverlay) {
            return;
        }

        const value = input.value;

        // Don't show suggestion for empty input
        if (!value.trim()) {
            this.hideSuggestion();
            return;
        }

        // Parse input to get command and arguments
        const parts = value.split(/[\s,]+/).filter(p => p.length > 0);
        if (parts.length === 0) {
            this.hideSuggestion();
            return;
        }

        const command = parts[0].toUpperCase();
        const argsEntered = parts.length - 1;

        // Get command parameters from cmddict
        if (!this.stateManager) {
            this.hideSuggestion();
            return;
        }

        const cmddict = this.stateManager.getCommandDict();
        if (!cmddict || !cmddict[command]) {
            this.hideSuggestion();
            return;
        }

        const rawParamString = cmddict[command];
        if (!rawParamString) {
            this.hideSuggestion();
            return;
        }

        // Use the user-facing signature here too so commands like MCRE
        // don't ghost-text lat/lon args that CommandHandler injects.
        const paramString = getDisplaySignature(command, rawParamString);

        // Split parameters by comma
        const allParams = paramString.split(',').map(p => p.trim());

        // Get remaining parameters (not yet entered)
        const remainingParams = allParams.slice(argsEntered);

        if (remainingParams.length === 0) {
            this.hideSuggestion();
            return;
        }

        // Show remaining parameters
        this.showSuggestion(remainingParams.join(', '), value);
    }

    /**
     * Show suggestion overlay with remaining parameters
     */
    private showSuggestion(suggestionText: string, currentInput: string): void {
        if (!this.suggestionOverlay) return;

        // Set suggestion text
        this.suggestionOverlay.textContent = suggestionText;
        this.suggestionOverlay.style.display = 'block';

        // Position suggestion after current input text
        const input = document.getElementById('console-input') as HTMLInputElement;
        const prompt = document.querySelector('.console-prompt') as HTMLElement;

        if (input && prompt) {
            // Calculate position based on input text width
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            if (context) {
                const computedStyle = window.getComputedStyle(input);
                context.font = computedStyle.font;
                const textWidth = context.measureText(currentInput).width;

                // Account for prompt width and input padding/border
                const promptWidth = prompt.offsetWidth;
                const inputPadding = parseInt(computedStyle.paddingLeft || '0');
                const inputBorder = parseInt(computedStyle.borderLeftWidth || '0');

                // Add spacing between typed text and suggestion (in pixels)
                const suggestionSpacing = 20;

                // Position suggestion overlay after the input text with spacing
                // Add prompt width, input padding/border, the text width, and extra spacing
                this.suggestionOverlay.style.left = `${promptWidth + inputPadding + inputBorder + textWidth + suggestionSpacing}px`;
            }
        }
    }

    /**
     * Hide suggestion overlay
     */
    private hideSuggestion(): void {
        if (this.suggestionOverlay) {
            this.suggestionOverlay.style.display = 'none';
        }
    }

    /**
     * Update the inline argument-signature hint row beneath the input.
     *
     * Renders one chip per arg in the signature; the chip the cursor sits
     * on gets the `current` modifier so the user can see which argument
     * they're filling in. When the typed command isn't in cmddict (and
     * cmddict has actually loaded), we replace the chips with a pointer to
     * the command palette so the user has a clue when they're stuck.
     */
    private updateArgHint(): void {
        if (!this.argHint) return;
        const input = document.getElementById('console-input') as HTMLInputElement;
        if (!input) return;

        const value = input.value;
        if (!value.trim()) {
            this.hideArgHint();
            return;
        }

        const command = commandFromInput(value);
        if (!command) {
            this.hideArgHint();
            return;
        }

        if (!this.stateManager) {
            this.hideArgHint();
            return;
        }
        const cmddict = this.stateManager.getCommandDict();
        const rawSig = cmddict ? cmddict[command] : undefined;

        if (rawSig === undefined) {
            // Only render the unknown-command hint once cmddict has loaded -
            // otherwise we'd flash the hint on every keystroke during boot.
            if (cmddict && Object.keys(cmddict).length > 0) {
                this.renderUnknownCommandHint(command);
            } else {
                this.hideArgHint();
            }
            return;
        }

        // Some commands (MCRE) have args injected by CommandHandler before
        // sending, so the signature shown to the user differs from the wire
        // signature in cmddict. Use the display version for the hint.
        const sig = getDisplaySignature(command, rawSig);
        const args: SignatureArg[] = parseSignature(sig);
        const cursor = input.selectionStart ?? value.length;
        const idx = currentArgIndex(value, cursor);

        this.argHint.innerHTML = '';

        const cmdLabel = document.createElement('span');
        cmdLabel.className = 'cmd-arg-cmd';
        cmdLabel.textContent = command;
        this.argHint.appendChild(cmdLabel);

        if (args.length === 0) {
            const noArgs = document.createElement('span');
            noArgs.className = 'cmd-arg-empty';
            noArgs.textContent = '(no arguments)';
            this.argHint.appendChild(noArgs);
        } else {
            args.forEach((arg, i) => {
                const chip = document.createElement('span');
                chip.className = 'cmd-arg-chip';
                if (arg.optional) chip.classList.add('optional');
                if (i === idx) chip.classList.add('current');
                chip.textContent = arg.optional ? `[${arg.name}]` : arg.name;
                this.argHint!.appendChild(chip);
            });
        }

        this.argHint.style.display = 'flex';
    }

    /**
     * Show a "command not in cmddict — try the palette" message in the arg
     * hint row. Uses ⌘ on macOS, Ctrl elsewhere.
     */
    private renderUnknownCommandHint(command: string): void {
        if (!this.argHint) return;
        this.argHint.innerHTML = '';

        const cmdLabel = document.createElement('span');
        cmdLabel.className = 'cmd-arg-cmd cmd-arg-unknown';
        cmdLabel.textContent = command;
        this.argHint.appendChild(cmdLabel);

        const message = document.createElement('span');
        message.className = 'cmd-arg-empty';
        message.textContent = 'unknown — press';
        this.argHint.appendChild(message);

        const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
        const kbd = document.createElement('kbd');
        kbd.className = 'cmd-arg-kbd';
        kbd.textContent = isMac ? '⌘' : 'Ctrl';
        this.argHint.appendChild(kbd);

        const plus = document.createElement('span');
        plus.className = 'cmd-arg-empty';
        plus.textContent = '+';
        this.argHint.appendChild(plus);

        const kbd2 = document.createElement('kbd');
        kbd2.className = 'cmd-arg-kbd';
        kbd2.textContent = 'K';
        this.argHint.appendChild(kbd2);

        const tail = document.createElement('span');
        tail.className = 'cmd-arg-empty';
        tail.textContent = 'to browse all commands';
        this.argHint.appendChild(tail);

        this.argHint.style.display = 'flex';
    }

    /**
     * Hide the argument-signature hint row.
     */
    private hideArgHint(): void {
        if (this.argHint) {
            this.argHint.style.display = 'none';
            this.argHint.innerHTML = '';
        }
    }

    /**
     * Replace the console input contents with `text`, focus the input,
     * move the cursor to the end, and refresh all derived UI (suggestion,
     * arg hint, ACID/type autocomplete, map picker).
     *
     * Used by the command palette modal and left panel to drop a selected
     * command name into the input.
     */
    public setInputValue(text: string): void {
        const input = document.getElementById('console-input') as HTMLInputElement;
        if (!input) return;
        input.value = text;
        input.focus();
        input.setSelectionRange(text.length, text.length);
        this.updateSuggestion();
        this.updateArgHint();
        this.updateAcidAutocomplete();
        this.updateTypeAutocomplete();
        this.updateMapPicker();
    }

    /**
     * Submit whatever is currently typed in the console input as if Enter
     * had been pressed, trimming trailing separators first. Used by
     * ConsoleMapPicker to finish a POLY-family drawing on right-click.
     */
    public submitCurrent(): void {
        const input = document.getElementById('console-input') as HTMLInputElement;
        if (!input) return;
        const value = input.value.replace(/[\s,]+$/, '');
        if (!value.trim()) {
            this.resetInput();
            return;
        }
        this.handleCommand(value);
        this.addToHistory(value);
        this.resetInput();
    }

    /**
     * Clear the console input and tear down all derived UI without
     * sending anything. Used by ConsoleMapPicker to cancel an in-progress
     * POLY-family drawing on Escape.
     */
    public clearInput(): void {
        this.resetInput();
    }

    /**
     * Shared cleanup used by Enter, submitCurrent, and clearInput: empty
     * the input, reset history navigation, hide all derived overlays, and
     * release the map picker.
     */
    private resetInput(): void {
        const input = document.getElementById('console-input') as HTMLInputElement;
        if (input) input.value = '';
        this.historyIndex = null;
        this.hideSuggestion();
        this.hideArgHint();
        this.hideAcidDropdown();
        this.hideAcidWarning();
        this.hideTypeDropdown();
        this.hideTypeWarning();
        this.mapPicker?.disable();
    }

    /**
     * Create the ACID autocomplete dropdown element
     */
    private createAcidDropdown(): void {
        const inputContainer = document.querySelector('.console-input-container');
        if (!inputContainer) return;

        this.acidDropdown = document.createElement('div');
        this.acidDropdown.className = 'acid-autocomplete-dropdown';
        this.acidDropdown.style.display = 'none';
        inputContainer.appendChild(this.acidDropdown);
    }

    /**
     * Create the CRE warning element for duplicate aircraft IDs
     */
    private createAcidWarning(): void {
        const inputContainer = document.querySelector('.console-input-container');
        if (!inputContainer) return;

        this.acidWarning = document.createElement('div');
        this.acidWarning.className = 'acid-warning';
        this.acidWarning.style.display = 'none';
        inputContainer.appendChild(this.acidWarning);
    }

    /**
     * Get current aircraft IDs from state
     */
    private getAircraftIds(): string[] {
        if (!this.stateManager) return [];
        const aircraftData = this.stateManager.getState().aircraftData;
        if (!aircraftData || !aircraftData.id) return [];
        return aircraftData.id;
    }

    /**
     * Parse a cmddict parameter string into normalized parameter names.
     *
     * Thin wrapper over the shared `parseSignature` helper used by the
     * command palette, so both surfaces stay aligned on bracket / slash
     * handling.
     */
    private parseCmdParams(paramString: string): string[] {
        return parseSignature(paramString).map(arg => arg.name);
    }

    /**
     * Split the console input into tokens, keeping the character range each
     * token occupies. Used by getArgAtCursor() so callers can locate the
     * token under the cursor without re-scanning the string.
     */
    private tokenizeInput(value: string): Array<{ text: string; start: number; end: number }> {
        const SEP = /[\s,]/;
        const tokens: Array<{ text: string; start: number; end: number }> = [];
        let i = 0;
        while (i < value.length) {
            while (i < value.length && SEP.test(value[i])) i++;
            if (i >= value.length) break;
            const start = i;
            while (i < value.length && !SEP.test(value[i])) i++;
            tokens.push({ text: value.substring(start, i), start, end: i });
        }
        return tokens;
    }

    /**
     * Find which argument slot the cursor currently sits on. Callers use this
     * to show the ACID / aircraft-type dropdowns based on the actual cursor
     * position rather than always assuming the cursor is at the end of the
     * input - so clicking back into an earlier token (e.g. the aircraft type
     * in a fully-typed CRE command) correctly re-opens that slot's dropdown.
     *
     * currentArgIndex is 0-based into the command's parameter list: the
     * command token itself is conceptually at index -1, the first real
     * argument is 0, and so on. When the cursor is inside a separator run,
     * partialText is empty and currentArgIndex is the slot that would be
     * filled next.
     */
    private getArgAtCursor(value: string, cursorPos: number): {
        currentArgIndex: number;
        partialText: string;
        tokenStart: number;
        tokenEnd: number;
        parts: string[];
    } {
        const tokens = this.tokenizeInput(value);
        const parts = tokens.map(t => t.text);

        // Cursor sitting on a token (including at its boundaries) reports that
        // token as the active slot. The <= end check lets a fresh keystroke at
        // end of token still match, matching the previous end-of-input path.
        for (let t = 0; t < tokens.length; t++) {
            const tok = tokens[t];
            if (cursorPos >= tok.start && cursorPos <= tok.end) {
                return {
                    currentArgIndex: t - 1,
                    partialText: tok.text,
                    tokenStart: tok.start,
                    tokenEnd: tok.end,
                    parts,
                };
            }
        }

        // Cursor is in a separator run (or past all tokens): the active slot
        // is whatever would come next, so count completed tokens before the
        // cursor.
        let tokensBefore = 0;
        for (const tok of tokens) {
            if (tok.end <= cursorPos) tokensBefore++;
            else break;
        }
        return {
            currentArgIndex: tokensBefore - 1,
            partialText: '',
            tokenStart: cursorPos,
            tokenEnd: cursorPos,
            parts,
        };
    }

    /**
     * Read the console input's current cursor position, falling back to the
     * end of the value when the selection API returns null.
     */
    private getCursorPos(input: HTMLInputElement): number {
        return input.selectionStart ?? input.value.length;
    }

    /**
     * Check if the current command expects an acid parameter at the current cursor position
     * Returns the partial acid text if applicable, null otherwise
     */
    private getAcidContext(value: string, cursorPos: number): { partialAcid: string; isCreCommand: boolean; acidArgIndex: number; isMidInput: boolean } | null {
        const { currentArgIndex, partialText, tokenEnd, parts } = this.getArgAtCursor(value, cursorPos);
        if (parts.length < 1) return null;

        // "Mid-input" means the cursor sits on a token that's followed by more
        // command content - the user is editing an earlier slot rather than
        // typing at the end. We use this to keep the dropdown visible even on
        // an exact match, so they can swap the value for a different one.
        const isMidInput = value.substring(tokenEnd).trim().length > 0;

        const command = parts[0].toUpperCase();
        const isCreCommand = command === 'CRE' || command === 'MCRE';

        // Get command parameters from cmddict
        if (!this.stateManager) return null;
        const cmddict = this.stateManager.getCommandDict();
        if (!cmddict || !cmddict[command]) return null;

        const rawParamString = cmddict[command];
        if (!rawParamString) return null;

        // Use the user-facing signature so MCRE (where CommandHandler
        // injects lat/lon) lines up the user's typed args with the param
        // positions we're inspecting.
        const paramString = getDisplaySignature(command, rawParamString);
        const params = this.parseCmdParams(paramString);

        // Find which parameter position we're at
        if (currentArgIndex < 0 || currentArgIndex >= params.length) return null;

        const currentParam = params[currentArgIndex];

        // Check if this parameter is an acid-type parameter
        const acidParamNames = ['acid', 'acidx', 'id', 'idx'];
        if (!acidParamNames.includes(currentParam)) return null;

        return { partialAcid: partialText, isCreCommand, acidArgIndex: currentArgIndex, isMidInput };
    }

    /**
     * Update the ACID autocomplete dropdown based on current input
     */
    private updateAcidAutocomplete(): void {
        const input = document.getElementById('console-input') as HTMLInputElement;
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
        const allIds = this.getAircraftIds();

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

        // Filter aircraft IDs by partial match
        const upperPartial = partialAcid.toUpperCase();
        let filtered: string[];
        if (upperPartial.length === 0) {
            filtered = [...allIds]; // Show all, dropdown scrolls
        } else {
            filtered = allIds.filter(id =>
                id.toUpperCase().startsWith(upperPartial)
            );
            // Also include IDs that contain the search term (not just starts-with)
            const containsMatches = allIds.filter(id =>
                !id.toUpperCase().startsWith(upperPartial) &&
                id.toUpperCase().includes(upperPartial)
            );
            filtered = [...filtered, ...containsMatches];
        }

        if (filtered.length === 0) {
            this.hideAcidDropdown();
            return;
        }

        // When typing at end-of-input, an exact single match means the user
        // is done entering this slot - hide the dropdown to get out of the way.
        // When the cursor sits on a token that's followed by more content, the
        // user is editing an earlier slot, so we keep the dropdown visible so
        // they can swap the value for a different one.
        if (
            !isMidInput &&
            filtered.length === 1 &&
            filtered[0].toUpperCase() === upperPartial
        ) {
            this.hideAcidDropdown();
            return;
        }

        this.acidSuggestions = filtered;
        if (this.acidSelectedIndex >= filtered.length) {
            this.acidSelectedIndex = -1;
        }
        this.renderAcidDropdown();
    }

    /**
     * Render the ACID dropdown with current suggestions
     */
    private renderAcidDropdown(): void {
        if (!this.acidDropdown) return;

        this.acidDropdown.innerHTML = '';

        this.acidSuggestions.forEach((id, index) => {
            const item = document.createElement('div');
            item.className = 'acid-dropdown-item';
            if (index === this.acidSelectedIndex) {
                item.classList.add('selected');
            }
            item.textContent = id;
            item.addEventListener('mousedown', (e) => {
                e.preventDefault(); // Prevent input blur
                this.selectAcidSuggestion(index);
            });
            item.addEventListener('mouseenter', () => {
                // Update selection visually without re-rendering DOM
                const prev = this.acidDropdown?.querySelector('.acid-dropdown-item.selected');
                if (prev) prev.classList.remove('selected');
                item.classList.add('selected');
                this.acidSelectedIndex = index;
            });
            this.acidDropdown!.appendChild(item);
        });

        this.acidDropdown.style.display = 'block';

        // Scroll selected item into view
        if (this.acidSelectedIndex >= 0) {
            const selectedEl = this.acidDropdown.children[this.acidSelectedIndex] as HTMLElement;
            if (selectedEl) {
                selectedEl.scrollIntoView({ block: 'nearest' });
            }
        }
    }

    /**
     * Select an ACID suggestion and insert it into the input
     */
    private selectAcidSuggestion(index: number): void {
        const input = document.getElementById('console-input') as HTMLInputElement;
        if (!input || index < 0 || index >= this.acidSuggestions.length) return;

        const selectedId = this.acidSuggestions[index];
        this.replaceTokenAtCursor(input, selectedId);

        this.hideAcidDropdown();
        input.focus();
        this.updateSuggestion();
        this.updateMapPicker();
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
        const { tokenStart, tokenEnd } = this.getArgAtCursor(value, cursorPos);

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

    /**
     * Handle arrow key navigation in the ACID dropdown
     * Returns true if the event was handled
     */
    private handleAcidDropdownKey(key: string): boolean {
        if (!this.acidDropdown || this.acidDropdown.style.display === 'none') {
            return false;
        }

        if (key === 'ArrowDown') {
            this.acidSelectedIndex = Math.min(
                this.acidSelectedIndex + 1,
                this.acidSuggestions.length - 1
            );
            this.renderAcidDropdown();
            return true;
        }

        if (key === 'ArrowUp') {
            this.acidSelectedIndex = Math.max(this.acidSelectedIndex - 1, -1);
            this.renderAcidDropdown();
            return true;
        }

        if (key === 'Tab' || key === 'Enter') {
            if (this.acidSelectedIndex >= 0) {
                this.selectAcidSuggestion(this.acidSelectedIndex);
                return true;
            }
        }

        if (key === 'Escape') {
            this.hideAcidDropdown();
            return true;
        }

        return false;
    }

    /**
     * Hide the ACID autocomplete dropdown
     */
    private hideAcidDropdown(): void {
        if (this.acidDropdown) {
            this.acidDropdown.style.display = 'none';
        }
        this.acidSuggestions = [];
        this.acidSelectedIndex = -1;
    }

    /**
     * Show the CRE duplicate aircraft warning
     */
    private showAcidWarning(message: string): void {
        if (!this.acidWarning) return;
        this.acidWarning.textContent = message;
        this.acidWarning.style.display = 'block';
    }

    /**
     * Hide the CRE duplicate aircraft warning
     */
    private hideAcidWarning(): void {
        if (this.acidWarning) {
            this.acidWarning.style.display = 'none';
        }
    }

    /**
     * Create the aircraft type autocomplete dropdown element
     */
    private createTypeDropdown(): void {
        const inputContainer = document.querySelector('.console-input-container');
        if (!inputContainer) return;

        this.typeDropdown = document.createElement('div');
        this.typeDropdown.className = 'actype-autocomplete-dropdown';
        this.typeDropdown.style.display = 'none';
        inputContainer.appendChild(this.typeDropdown);
    }

    /**
     * Check if the cursor sits on the aircraft-type parameter of a CRE/MCRE
     * command. Returns the partial type being typed when applicable.
     */
    private getTypeContext(value: string, cursorPos: number): { partialType: string; isMidInput: boolean } | null {
        const { currentArgIndex, partialText, tokenEnd, parts } = this.getArgAtCursor(value, cursorPos);
        if (parts.length < 1) return null;

        const isMidInput = value.substring(tokenEnd).trim().length > 0;

        const command = parts[0].toUpperCase();
        if (command !== 'CRE' && command !== 'MCRE') return null;

        // Look up the parameter list from cmddict so we follow whatever
        // argument order the server advertises.
        if (!this.stateManager) return null;
        const cmddict = this.stateManager.getCommandDict();
        if (!cmddict || !cmddict[command]) return null;

        const rawParamString = cmddict[command];
        if (!rawParamString) return null;

        // Use the user-facing signature so MCRE's `type` arg lines up at
        // the position the user actually types it (right after `n`).
        const paramString = getDisplaySignature(command, rawParamString);
        const params = this.parseCmdParams(paramString);

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
        const input = document.getElementById('console-input') as HTMLInputElement;
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

        // Filter aircraft types by prefix, then by contains (so users can still
        // find types by partial substring). Empty partial = show all types.
        let filtered: string[];
        if (upperPartial.length === 0) {
            filtered = [...this.aircraftTypes];
        } else {
            const startsWith = this.aircraftTypes.filter(t =>
                t.startsWith(upperPartial)
            );
            const contains = this.aircraftTypes.filter(t =>
                !t.startsWith(upperPartial) && t.includes(upperPartial)
            );
            filtered = [...startsWith, ...contains];
        }

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

        // When typing at end-of-input, an exact single match means the user is
        // done entering this slot - hide the dropdown. When the cursor sits on
        // a token followed by more content, the user is editing an earlier
        // slot, so keep the dropdown visible so they can pick a different type.
        if (
            !isMidInput &&
            filtered.length === 1 &&
            filtered[0].toUpperCase() === upperPartial
        ) {
            this.hideTypeDropdown();
            this.hideTypeWarning();
            return;
        }

        // Partial matches exist - user is still typing a valid openap type.
        this.hideTypeWarning();

        this.typeSuggestions = filtered;
        if (this.typeSelectedIndex >= filtered.length) {
            this.typeSelectedIndex = -1;
        }
        this.renderTypeDropdown();
    }

    /**
     * Render the type dropdown with current suggestions
     */
    private renderTypeDropdown(): void {
        if (!this.typeDropdown) return;

        this.typeDropdown.innerHTML = '';

        this.typeSuggestions.forEach((type, index) => {
            const item = document.createElement('div');
            item.className = 'actype-dropdown-item';
            if (index === this.typeSelectedIndex) {
                item.classList.add('selected');
            }
            item.textContent = type;
            item.addEventListener('mousedown', (e) => {
                e.preventDefault(); // Prevent input blur
                this.selectTypeSuggestion(index);
            });
            item.addEventListener('mouseenter', () => {
                const prev = this.typeDropdown?.querySelector('.actype-dropdown-item.selected');
                if (prev) prev.classList.remove('selected');
                item.classList.add('selected');
                this.typeSelectedIndex = index;
            });
            this.typeDropdown!.appendChild(item);
        });

        this.typeDropdown.style.display = 'block';

        // Scroll selected item into view
        if (this.typeSelectedIndex >= 0) {
            const selectedEl = this.typeDropdown.children[this.typeSelectedIndex] as HTMLElement;
            if (selectedEl) {
                selectedEl.scrollIntoView({ block: 'nearest' });
            }
        }
    }

    /**
     * Select a type suggestion and insert it into the input
     */
    private selectTypeSuggestion(index: number): void {
        const input = document.getElementById('console-input') as HTMLInputElement;
        if (!input || index < 0 || index >= this.typeSuggestions.length) return;

        const selectedType = this.typeSuggestions[index];
        this.replaceTokenAtCursor(input, selectedType);

        this.hideTypeDropdown();
        input.focus();
        this.updateSuggestion();
        this.updateMapPicker();
    }

    /**
     * Handle arrow key navigation in the type dropdown
     * Returns true if the event was handled
     */
    private handleTypeDropdownKey(key: string): boolean {
        if (!this.typeDropdown || this.typeDropdown.style.display === 'none') {
            return false;
        }

        if (key === 'ArrowDown') {
            this.typeSelectedIndex = Math.min(
                this.typeSelectedIndex + 1,
                this.typeSuggestions.length - 1
            );
            this.renderTypeDropdown();
            return true;
        }

        if (key === 'ArrowUp') {
            this.typeSelectedIndex = Math.max(this.typeSelectedIndex - 1, -1);
            this.renderTypeDropdown();
            return true;
        }

        if (key === 'Tab' || key === 'Enter') {
            if (this.typeSelectedIndex >= 0) {
                this.selectTypeSuggestion(this.typeSelectedIndex);
                return true;
            }
        }

        if (key === 'Escape') {
            this.hideTypeDropdown();
            return true;
        }

        return false;
    }

    /**
     * Hide the aircraft type autocomplete dropdown
     */
    private hideTypeDropdown(): void {
        if (this.typeDropdown) {
            this.typeDropdown.style.display = 'none';
        }
        this.typeSuggestions = [];
        this.typeSelectedIndex = -1;
    }

    /**
     * Create the inline warning element shown when the aircraft type in a
     * CRE/MCRE command is not part of the openap library. Mirrors the
     * Create Aircraft modal behaviour.
     */
    private createTypeWarning(): void {
        const inputContainer = document.querySelector('.console-input-container');
        if (!inputContainer) return;

        this.typeWarning = document.createElement('div');
        this.typeWarning.className = 'actype-warning';
        this.typeWarning.style.display = 'none';
        inputContainer.appendChild(this.typeWarning);
    }

    /**
     * Show the openap aircraft type warning with the given message
     */
    private showTypeWarning(message: string): void {
        if (!this.typeWarning) return;
        this.typeWarning.textContent = message;
        this.typeWarning.style.display = 'block';
    }

    /**
     * Hide the openap aircraft type warning
     */
    private hideTypeWarning(): void {
        if (this.typeWarning) {
            this.typeWarning.style.display = 'none';
        }
    }

    /**
     * Check whether the cursor sits on a lat/lon/hdg parameter of the current
     * command according to the BlueSky cmddict signature. When it does,
     * returns a context object consumed by ConsoleMapPicker.
     *
     * For POLY-family commands the cmddict signature ends with `...` to mean
     * "and so on with more lat,lon pairs". We detect that and synthetically
     * extend the params list so the picker stays engaged across many clicks
     * instead of disabling after the first explicit pair.
     */
    private getGeoContext(value: string, cursorPos: number): GeoContext | null {
        const { currentArgIndex, parts } = this.getArgAtCursor(value, cursorPos);
        if (parts.length < 1) return null;

        const command = parts[0].toUpperCase();

        if (!this.stateManager) return null;
        const cmddict = this.stateManager.getCommandDict();
        if (!cmddict || !cmddict[command]) return null;

        const rawParamString = cmddict[command];
        if (!rawParamString) return null;

        // Honour user-facing overrides so commands like MCRE don't engage
        // the picker on lat/lon slots that CommandHandler fills in.
        const paramString = getDisplaySignature(command, rawParamString);
        let params = this.parseCmdParams(paramString);

        if (currentArgIndex < 0) return null;

        // Variadic POLY-family: signature looks like "...,lat,lon,..." with
        // a trailing "..." sentinel. Extend params with repeating lat,lon
        // pairs so the picker keeps working past the explicit list.
        const variadic =
            params.length >= 1 && params[params.length - 1] === '...';
        const baseParams = variadic ? params.slice(0, -1) : params;
        const tailIsLatLon =
            baseParams.length >= 2 &&
            baseParams[baseParams.length - 2] === 'lat' &&
            baseParams[baseParams.length - 1] === 'lon';

        if (variadic && tailIsLatLon) {
            const latStart = baseParams.length - 2;
            const extended = [...baseParams];
            // Push enough pairs that any reasonable polygon fits and the
            // trailing-comma logic in insertGeoValue keeps adding `,`.
            const target = Math.max(currentArgIndex + 4, baseParams.length + 40);
            while (extended.length < target) {
                const offset = (extended.length - latStart) % 2;
                extended.push(offset === 0 ? 'lat' : 'lon');
            }
            params = extended;
        } else if (variadic) {
            // Non lat/lon variadic - just drop the sentinel.
            params = baseParams;
        }

        if (currentArgIndex >= params.length) return null;

        const currentParam = params[currentArgIndex];
        const geoParamNames = ['lat', 'lon', 'hdg'];
        if (!geoParamNames.includes(currentParam)) return null;

        // Heading picking only makes sense for CRE, where lat/lon immediately
        // precede hdg in the signature and give us a clear spatial origin for
        // the bearing. Other commands (e.g. HDG acid,hdg) have no such origin,
        // so we stay out of the way.
        if (currentParam === 'hdg' && command !== 'CRE') return null;

        return {
            kind: currentParam as 'lat' | 'lon' | 'hdg',
            currentArgIndex,
            params,
            parts,
            command,
        };
    }

    /**
     * Find the character index in `value` where the argument at position
     * `argIndex` begins. Walks across alternating non-separator/separator
     * regions and stops just after the (argIndex + 1)th separator run so the
     * returned index sits at the first character of the target argument.
     *
     * Used by insertGeoValue() to strip any already-typed content for a
     * specific arg slot (or range of slots) before inserting new values from
     * a map click.
     */
    private findArgStartIndex(value: string, argIndex: number): number {
        const SEP = /[\s,]/;
        let i = 0;
        let sepsPassed = 0;
        const sepsNeeded = argIndex + 1;
        while (sepsPassed < sepsNeeded) {
            while (i < value.length && !SEP.test(value[i])) i++;
            if (i >= value.length) return value.length;
            while (i < value.length && SEP.test(value[i])) i++;
            sepsPassed++;
        }
        return i;
    }

    /**
     * Enable or disable the map picker based on the current input state.
     * Called on every input event alongside suggestion/autocomplete updates.
     */
    private updateMapPicker(): void {
        if (!this.mapPicker) return;
        const input = document.getElementById('console-input') as HTMLInputElement;
        if (!input) return;

        const ctx = this.getGeoContext(input.value, this.getCursorPos(input));
        if (ctx) {
            this.mapPicker.enable(ctx);
        } else {
            this.mapPicker.disable();
        }
    }

    /**
     * Insert a value into the console input, overwriting the argument slot(s)
     * starting at `replaceFromArgIndex`. Used by ConsoleMapPicker to drop
     * coordinates or a heading into the command being typed.
     *
     * The replacement is slot-based rather than token-based: if the user has
     * already typed values for lat and lon and then clicks on the map, the
     * picker will pass replaceFromArgIndex = (lat's index) and the full pair,
     * and this method truncates everything from the start of the lat slot
     * onwards before inserting. That way a single click cleanly replaces both
     * coordinates without leaving fragments behind.
     *
     * @param value - The text to insert (e.g. "52.370000,4.900000" or "270")
     * @param replaceFromArgIndex - The argument index to truncate back to.
     *     Everything from this slot onward is discarded before the insert.
     * @param argsAdvanced - How many arguments the insertion fills starting
     *     at replaceFromArgIndex. Used to decide whether a trailing comma
     *     (more args expected) or a trailing space (command complete) is
     *     appended. Pass 2 for a lat,lon pair, 1 for a single value.
     */
    public insertGeoValue(
        value: string,
        replaceFromArgIndex: number,
        argsAdvanced: number
    ): void {
        const input = document.getElementById('console-input') as HTMLInputElement;
        if (!input) return;

        const ctx = this.getGeoContext(input.value, this.getCursorPos(input));
        const current = input.value;

        // Truncate the input back to the start of the slot we're overwriting.
        const argStart = this.findArgStartIndex(current, replaceFromArgIndex);
        let newValue = current.substring(0, argStart) + value;

        // Append a trailing comma when more arguments are expected, a space
        // when the command is complete. This lets the next geo slot light up
        // automatically after the click.
        if (ctx) {
            const nextArgIndex = replaceFromArgIndex + argsAdvanced;
            newValue += nextArgIndex < ctx.params.length ? ',' : ' ';
        }

        input.value = newValue;
        input.focus();
        input.setSelectionRange(newValue.length, newValue.length);

        // Re-run downstream updates so the next geo slot (if any) picks up
        // immediately - e.g. a lat,lon click advances into hdg mode and the
        // heading guide line / position marker appear on the next mouse move.
        this.updateSuggestion();
        this.updateArgHint();
        this.updateMapPicker();
    }
}