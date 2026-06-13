import { storage } from '../utils/StorageManager';
import { logger } from '../utils/Logger';

/**
 * CommandHistory - the console's persisted command history with
 * up/down-arrow navigation, extracted from Console so the navigation
 * semantics are testable without a DOM.
 *
 * Navigation model: a null index means "fresh input line". previous()
 * walks toward older commands and sticks at the oldest (no cycling);
 * next() walks toward newer commands and finally returns to the fresh
 * line (empty string).
 */
export class CommandHistory {
    private history: string[] = [];
    private index: number | null = null; // null means fresh input line

    constructor(
        private readonly storageKey: string = 'console-command-history',
        private readonly maxEntries: number = 100
    ) {}

    /** Load persisted history from localStorage. */
    load(): void {
        const savedHistory = storage.get<string[]>(this.storageKey, []);
        if (savedHistory && Array.isArray(savedHistory)) {
            this.history = savedHistory;
            logger.info('Console', `Loaded ${this.history.length} commands from history`);
        }
    }

    /** Append a command (newest last), cap the size, and persist. */
    add(command: string): void {
        if (!command.trim()) return;

        this.history.push(command);
        if (this.history.length > this.maxEntries) {
            this.history.shift(); // Remove oldest command
        }
        storage.set(this.storageKey, this.history);
    }

    /**
     * Step to the previous (older) command. Returns the command to show,
     * or null when there is no history to navigate.
     */
    previous(): string | null {
        if (this.history.length === 0) return null;

        // If we're at fresh input state, go to newest command
        if (this.index === null) {
            this.index = this.history.length - 1;
        } else if (this.index > 0) {
            // Move to older command
            this.index--;
        }
        // If already at oldest command, stay there (no cycling)

        return this.history[this.index];
    }

    /**
     * Step to the next (newer) command. Returns the command to show,
     * '' when stepping past the newest back to the fresh input line, or
     * null when not currently navigating.
     */
    next(): string | null {
        if (this.history.length === 0 || this.index === null) {
            return null;
        }

        if (this.index < this.history.length - 1) {
            this.index++;
            return this.history[this.index];
        }

        // At newest command, go back to fresh input
        this.index = null;
        return '';
    }

    /** Return to the fresh-input state (e.g. after submitting a command). */
    resetNavigation(): void {
        this.index = null;
    }

    get entries(): readonly string[] {
        return this.history;
    }
}
