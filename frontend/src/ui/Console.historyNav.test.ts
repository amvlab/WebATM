// @vitest-environment happy-dom
/**
 * Console arrow-key history navigation, wired end-to-end through the real
 * keydown handler. Pins the fix for the draft-loss bug: an unsubmitted
 * command must survive an ArrowUp (recall history) → ArrowDown (come back)
 * round trip instead of being wiped to an empty input.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Console } from './Console';

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

function submit(command: string): void {
    input().value = command;
    (document.getElementById('send-command') as HTMLButtonElement).click();
}

describe('Console arrow-key history navigation', () => {
    const app = { sendCommand: vi.fn() };
    let konsole: Console;

    beforeEach(() => {
        localStorage.clear();
        setupDom();
        app.sendCommand.mockReset();
        window.app = app as unknown as Window['app'];
        konsole = new Console();
        submit('MCRE 2');
        submit('OP');
    });

    afterEach(() => {
        delete window.app;
        document.body.innerHTML = '';
    });

    it('ArrowUp recalls the newest command, ArrowUp again the older one', () => {
        press('ArrowUp');
        expect(input().value).toBe('OP');
        press('ArrowUp');
        expect(input().value).toBe('MCRE 2');
    });

    it('preserves an unsubmitted draft across an ArrowUp/ArrowDown round trip', () => {
        input().value = 'CRE KL204 B744 52.3 4.9';
        press('ArrowUp');
        expect(input().value).toBe('OP');
        press('ArrowDown');
        expect(input().value).toBe('CRE KL204 B744 52.3 4.9');
    });

    it('a command recorded mid-navigation restarts ArrowUp at the newest entry', () => {
        press('ArrowUp'); // OP
        press('ArrowUp'); // MCRE 2
        konsole.displaySentCommand('HOLD'); // e.g. a map-drawn aircraft
        press('ArrowUp');
        expect(input().value).toBe('HOLD');
    });

    it('submitting resets navigation and the draft', () => {
        input().value = 'a draft';
        press('ArrowUp'); // OP, draft stashed
        submit('HOLD');
        press('ArrowUp');
        expect(input().value).toBe('HOLD');
        press('ArrowDown');
        expect(input().value).toBe(''); // draft was consumed by the submit
    });
});
