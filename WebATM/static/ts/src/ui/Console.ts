import { App } from '../core/App';
import type { StateManager } from '../core/StateManager';
import { storage } from '../utils/StorageManager';
import { CommandHandler } from '../data/CommandHandler';
import { logger } from '../utils/Logger';

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

    constructor() {
        this.aircraftTypes = [
            'A320', 'A321', 'A330', 'A340', 'A350', 'A380',
            'B737', 'B747', 'B757', 'B767', 'B777', 'B787',
            'E170', 'E190', 'CRJ2', 'CRJ7', 'CRJ9',
            'AT72', 'DH8D', 'F50', 'B412', 'AS50'
        ];

        // Load command history from localStorage
        this.loadHistory();

        this.init();
    }

    private init(): void {
        this.setupEventListeners();
        this.createSuggestionOverlay();
        this.clearDisplay();
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

        // Handle arrow keys for command history
        input.addEventListener('keydown', (e: KeyboardEvent) => {
            switch (e.key) {
                case 'ArrowUp':
                    e.preventDefault();
                    this.showPreviousCommand();
                    this.updateSuggestion();
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    this.showNextCommand();
                    this.updateSuggestion();
                    break;
                case 'Tab':
                    e.preventDefault();
                    this.autoComplete();
                    this.updateSuggestion();
                    break;
                case 'Enter':
                    this.handleCommand(input.value);
                    this.addToHistory(input.value);
                    input.value = '';
                    this.historyIndex = null;
                    this.hideSuggestion();
                    break;
            }
        });

        // Update suggestion as user types
        input.addEventListener('input', () => {
            this.updateSuggestion();
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
        } else if (words.length > 1 && words[0].toUpperCase() === 'CRE') {
            // Complete aircraft type for CRE command
            if (words.length === 3 && currentWord.length > 0) {
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

        const paramString = cmddict[command];
        if (!paramString) {
            this.hideSuggestion();
            return;
        }

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
}