// @vitest-environment happy-dom
/**
 * Tests for the console's two keyboard paths that go through
 * setupEventListeners():
 *
 * - Enter must be an exact mirror of the "Send" button, i.e. route through
 *   the shared submitCurrent() path. Before the fix Enter duplicated the
 *   submit logic inline and skipped the trailing-separator trim, so a
 *   command finished via the map picker (which appends a comma after every
 *   click) was sent with a dangling `,`.
 * - Tab completion must use the console's separator rules (spaces AND
 *   commas) and the cursor position. Before the fix it split on spaces
 *   only and always completed the last word, so the comma-separated form
 *   the app itself produces ("CRE KL123,A38") never completed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Console } from './Console';
import type { StateManager } from '../core/StateManager';

function setupDom(): void {
    document.body.innerHTML = `
        <div class="console-panel">
            <button id="clear-console">Clear</button>
            <div id="console-output"></div>
            <div class="console-input-container">
                <span class="console-prompt">BS&gt;</span>
                <input type="text" id="console-input" placeholder="Enter command… (Ctrl+K to browse)" autocomplete="off">
                <button id="send-command" class="console-btn">Send</button>
            </div>
        </div>
    `;
}

function input(): HTMLInputElement {
    return document.getElementById('console-input') as HTMLInputElement;
}

function press(key: string): void {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

/** Type a value and put the cursor at the given position (default: end). */
function type(value: string, cursor: number = value.length): void {
    const el = input();
    el.value = value;
    el.setSelectionRange(cursor, cursor);
}

const CMDDICT = {
    CRE: 'acid,type,lat,lon,hdg,alt,spd',
    HDG: 'acid,hdg',
};

function stateManagerStub(): StateManager {
    return {
        getCommandDict: () => CMDDICT,
        getState: () => ({ aircraftData: { id: [] } }),
    } as unknown as StateManager;
}

describe('Console Enter key', () => {
    const app = { sendCommand: vi.fn() };

    beforeEach(() => {
        localStorage.clear();
        setupDom();
        app.sendCommand.mockReset();
        window.app = app as unknown as Window['app'];
        new Console();
    });

    afterEach(() => {
        delete window.app;
        document.body.innerHTML = '';
    });

    it('sends the typed command and clears the input', () => {
        type('MCRE 5');
        press('Enter');
        expect(app.sendCommand).toHaveBeenCalledWith('MCRE 5');
        expect(input().value).toBe('');
    });

    it('trims trailing separators, matching the Send button', () => {
        // The console map picker appends a comma after every click, so this
        // is exactly what the input holds when a POLY is finished with Enter.
        type('POLY TEST,52.3,4.2,53.0,4.2,52.6,5.2,');
        press('Enter');
        expect(app.sendCommand).toHaveBeenCalledWith(
            'POLY TEST,52.3,4.2,53.0,4.2,52.6,5.2'
        );
    });

    it('stores the trimmed command in the arrow-key history', () => {
        type('MCRE 5, ');
        press('Enter');
        const saved = JSON.parse(
            localStorage.getItem('webatm-console-command-history') ?? '[]'
        );
        expect(saved).toContain('MCRE 5');
    });

    it('does nothing for an empty input', () => {
        type('  ');
        press('Enter');
        expect(app.sendCommand).not.toHaveBeenCalled();
    });
});

describe('Console Tab completion', () => {
    const app = { sendCommand: vi.fn() };
    let konsole: Console;

    beforeEach(() => {
        localStorage.clear();
        setupDom();
        app.sendCommand.mockReset();
        window.app = app as unknown as Window['app'];
        konsole = new Console();
        konsole.setStateManager(stateManagerStub());
    });

    afterEach(() => {
        delete window.app;
        document.body.innerHTML = '';
    });

    it('completes the aircraft type after a comma separator', () => {
        type('CRE KL123,A38');
        press('Tab');
        expect(input().value).toBe('CRE KL123,A388 ');
    });

    it('completes the aircraft type after a space separator', () => {
        type('CRE KL123 A38');
        press('Tab');
        expect(input().value).toBe('CRE KL123 A388 ');
    });

    it('completes the token under the cursor, keeping the tail', () => {
        const value = 'CRE KL123,A38 52 4';
        type(value, value.indexOf('A38') + 3); // cursor at end of "A38"
        press('Tab');
        expect(input().value).toBe('CRE KL123,A388 52 4');
    });

    it('completes a unique command prefix from cmddict', () => {
        type('HD');
        press('Tab');
        expect(input().value).toBe('HDG ');
    });

    it('echoes the alternatives when several types match', () => {
        type('CRE KL123,A32');
        press('Tab');
        expect(input().value).toBe('CRE KL123,A32'); // unchanged
        const output = document.getElementById('console-output');
        expect(output?.textContent).toContain('A320');
        expect(output?.textContent).toContain('A321');
    });

    it('does not complete types for non-CRE commands', () => {
        type('HDG KL123,A38');
        press('Tab');
        expect(input().value).toBe('HDG KL123,A38');
    });
});
