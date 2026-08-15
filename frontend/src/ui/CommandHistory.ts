import { storage } from '../utils/StorageManager';
import { logger } from '../utils/Logger';

/**
 * CommandHistory - the console's persisted command history with
 * up/down-arrow navigation, extracted from Console so the navigation
 * semantics are testable without a DOM.
 *
 * Navigation model (matches a shell): a null index means "fresh input
 * line". previous() walks toward older commands and sticks at the oldest
 * (no cycling); next() walks toward newer commands and finally restores
 * the draft that was on the fresh line when navigation started.
 */
export class CommandHistory {
    private history: string[] = [];
    private index: number | null = null; // null means fresh input line
    private draft: string | null = null; // fresh-line text stashed while navigating

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

    /**
     * Append a command (newest last), cap the size, and persist.
     * Skips blank input and consecutive duplicates, and ends any
     * in-progress navigation so the next ArrowUp starts at the newest
     * entry again.
     */
    add(command: string): void {
        this.resetNavigation();
        if (!command.trim()) return;
        if (this.history[this.history.length - 1] === command) return;

        this.history.push(command);
        if (this.history.length > this.maxEntries) {
            this.history.shift();
        }
        storage.set(this.storageKey, this.history);
    }

    /**
     * Step to the previous (older) command. Returns the command to show,
     * or null when there is no history to navigate. `currentInput` is
     * stashed as the draft when this step leaves the fresh input line.
     */
    previous(currentInput: string = ''): string | null {
        if (this.history.length === 0) return null;

        if (this.index === null) {
            this.draft = currentInput;
            this.index = this.history.length - 1;
        } else if (this.index > 0) {
            this.index--;
        }
        // else: already at the oldest command - stay there (no cycling)

        return this.history[this.index];
    }

    /**
     * Step to the next (newer) command. Returns the command to show, the
     * stashed draft when stepping past the newest back to the fresh input
     * line, or null when not currently navigating.
     */
    next(): string | null {
        if (this.history.length === 0 || this.index === null) {
            return null;
        }

        if (this.index < this.history.length - 1) {
            this.index++;
            return this.history[this.index];
        }

        const draft = this.draft ?? '';
        this.resetNavigation();
        return draft;
    }

    /** Return to the fresh-input state (e.g. after submitting a command). */
    resetNavigation(): void {
        this.index = null;
        this.draft = null;
    }

    get entries(): readonly string[] {
        return this.history;
    }
}
