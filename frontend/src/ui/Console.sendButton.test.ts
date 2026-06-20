// @vitest-environment happy-dom
/**
 * Regression test for issue #82: the console "Send" button (#send-command)
 * must submit the typed command, mirroring the Enter key.
 *
 * Before the fix the button had no click handler anywhere in the frontend, so
 * clicking it did nothing and the typed command was never sent to BlueSky -
 * Enter was the only submit path. These tests pin the click handler to the
 * shared submitCurrent() path (send, trim trailing separators, ignore empty,
 * clear the input).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Console } from './Console';

/**
 * Build the minimal slice of index.html the Console constructor reaches into:
 * the input container (with prompt + input + Send button), the output log, and
 * the Clear button. The container needs a parent so createArgHint() can insert
 * the hint row before it.
 */
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

function sendButton(): HTMLButtonElement {
    return document.getElementById('send-command') as HTMLButtonElement;
}

describe('Console "Send" button (#send-command)', () => {
    // With no CommandHandler registered, Console falls back to
    // window.app.sendCommand - the path these tests assert on.
    const app = { sendCommand: vi.fn(), addToHistory: vi.fn() };

    beforeEach(() => {
        localStorage.clear();
        setupDom();
        app.sendCommand.mockReset();
        app.addToHistory.mockReset();
        window.app = app as unknown as Window['app'];
        new Console();
    });

    afterEach(() => {
        delete window.app;
        document.body.innerHTML = '';
    });

    it('sends the typed command when clicked', () => {
        input().value = 'MCRE 5';
        sendButton().click();
        expect(app.sendCommand).toHaveBeenCalledWith('MCRE 5');
    });

    it('clears the input after a successful send', () => {
        input().value = 'CRE KL204 B738 52 4 90 FL300 250';
        sendButton().click();
        expect(input().value).toBe('');
    });

    it('trims trailing separators before sending', () => {
        input().value = 'MCRE 5, ';
        sendButton().click();
        expect(app.sendCommand).toHaveBeenCalledWith('MCRE 5');
    });

    it('does nothing for an empty / whitespace-only input', () => {
        input().value = '   ';
        sendButton().click();
        expect(app.sendCommand).not.toHaveBeenCalled();
    });
});
