import type { StateManager } from '../core/StateManager';
import { CommandHandler } from '../data/CommandHandler';
import { OPENAP_AIRCRAFT_TYPES } from '../data/aircraftTypes';
import { logger } from '../utils/Logger';
import { ConsoleMapPicker, GeoContext } from './ConsoleMapPicker';
import type { MapDisplay } from './map/MapDisplay';
import type { NavaidSnapper } from './map/navdata/NavaidSnapper';
import {
    parseSignature,
    currentArgIndex,
    commandFromInput,
    getDisplaySignature,
    SignatureArg,
} from '../data/CommandSignature';
import { CommandHistory } from './CommandHistory';
import { getArgAtCursor } from './consoleTokens';
import { CommandListView } from './CommandListView';
import { ConsoleAutocomplete } from './ConsoleAutocomplete';

export class Console {
    private history = new CommandHistory();
    private stateManager: StateManager | null = null;
    private suggestionOverlay: HTMLDivElement | null = null;
    private commandHandler: CommandHandler | null = null;

    // ACID and aircraft-type dropdowns attached to the input
    private autocomplete: ConsoleAutocomplete;

    // Map-click picker for lat/lon/hdg arguments
    private mapPicker: ConsoleMapPicker | null = null;

    // Inline argument-signature hint rendered above the input (from cmddict)
    private argHint: HTMLDivElement | null = null;

    constructor() {
        this.autocomplete = new ConsoleAutocomplete({
            getCommandDict: () => this.stateManager?.getCommandDict() ?? null,
            getAircraftIds: () => this.stateManager?.getState().aircraftData?.id ?? [],
            onAfterSelect: () => {
                this.updateSuggestion();
                this.updateMapPicker();
            }
        });

        // Load command history from localStorage
        this.loadHistory();

        this.init();
    }

    private init(): void {
        this.setupEventListeners();
        this.createSuggestionOverlay();
        this.createArgHint();
        this.autocomplete.createElements();
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
    public setMapDisplay(mapDisplay: MapDisplay, navaidSnapper: NavaidSnapper): void {
        this.mapPicker = new ConsoleMapPicker(mapDisplay, this, navaidSnapper);
    }

    /**
     * Create suggestion overlay element
     */
    private createSuggestionOverlay(): void {
        const inputContainer = document.querySelector('.console-input-container');
        if (!inputContainer) {
            logger.error('Console', 'Console input container not found');
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
        this.history.load();
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
            logger.error('Console', 'Console input element not found');
            return;
        }

        // Handle arrow keys for command history and ACID/type dropdowns
        input.addEventListener('keydown', (e: KeyboardEvent) => {
            // Let dropdowns handle keys first when visible
            if (this.autocomplete.handleKey(e.key)) {
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
                    this.autocomplete.hideTransient();
                    this.mapPicker?.disable();
                    break;
            }
        });

        // Update suggestion and ACID/type autocomplete as user types
        input.addEventListener('input', () => {
            this.updateSuggestion();
            this.updateArgHint();
            this.autocomplete.update();
            this.updateMapPicker();
        });

        // Refresh dropdowns when the cursor moves without a text change, so
        // clicking back into an earlier token (or navigating with the arrow
        // keys / Home / End) re-opens that slot's dropdown.
        const refreshForCursor = () => {
            this.updateArgHint();
            this.autocomplete.update();
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
                this.autocomplete.hideTransient();
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
                suggestions = OPENAP_AIRCRAFT_TYPES.filter(type =>
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
        this.history.add(command);

        // Also add to app.js history to keep them in sync
        if (window.app && window.app.addToHistory) {
            window.app.addToHistory(command);
        }
    }

    private showPreviousCommand(): void {
        const input = document.getElementById('console-input') as HTMLInputElement;
        if (!input) return;

        const command = this.history.previous();
        if (command !== null) {
            input.value = command;
        }
    }

    private showNextCommand(): void {
        const input = document.getElementById('console-input') as HTMLInputElement;
        if (!input) return;

        const command = this.history.next();
        if (command !== null) {
            input.value = command;
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
        this.autocomplete.update();
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
        this.history.resetNavigation();
        this.hideSuggestion();
        this.hideArgHint();
        this.autocomplete.hideAll();
        this.mapPicker?.disable();
    }

    /**
     * Read the console input's current cursor position, falling back to the
     * end of the value when the selection API returns null.
     */

    private getCursorPos(input: HTMLInputElement): number {
        return input.selectionStart ?? input.value.length;
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
        const { currentArgIndex, parts } = getArgAtCursor(value, cursorPos);
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
        let params = parseSignature(paramString).map(arg => arg.name);

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