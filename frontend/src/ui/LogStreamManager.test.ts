// @vitest-environment happy-dom
/**
 * Characterization tests for LogStreamManager's in-stream search highlighting.
 *
 * Highlighting is whole-line: matching `.log-stream-line` elements get the
 * `log-search-highlight` class (and the active match also gets `active`), with
 * no per-substring markup. These tests pin that behavior so the shared
 * highlight-clearing helper stays correct.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function buildDom(lines: string[]): void {
    const lineHtml = lines
        .map(text => `<div class="log-stream-line">${text}</div>`)
        .join('');
    document.body.innerHTML = `
        <div id="echo-output"></div>
        <div id="output-log-container">
            <div id="output-file-browser"></div>
            <div class="log-stream-output" id="log-stream-output">${lineHtml}</div>
            <div id="log-search-bar" style="display: flex;">
                <input id="log-search-input" type="text" />
                <span id="log-search-count"></span>
                <button id="log-search-prev"></button>
                <button id="log-search-next"></button>
                <button id="log-search-close"></button>
            </div>
        </div>
        <button id="echo-tab-btn"></button>
        <button id="log-stream-tab-btn" class="active"></button>
        <span id="log-stream-filename"></span>
        <button id="clear-echo"></button>
        <button id="refresh-output-files"></button>
        <button id="clear-log-stream"></button>
        <button id="stop-log-stream"></button>
    `;
}

function typeSearch(value: string): void {
    const input = document.getElementById('log-search-input') as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
}

function highlightedLines(): NodeListOf<Element> {
    return document.querySelectorAll('.log-stream-line.log-search-highlight');
}

describe('LogStreamManager search highlighting', () => {
    beforeEach(() => {
        vi.resetModules(); // fresh singleton per test
        // happy-dom does not implement scrollIntoView; the active match calls it.
        Element.prototype.scrollIntoView = vi.fn();
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('highlights every line containing the term and counts them', async () => {
        buildDom(['alpha bravo', 'charlie delta', 'echo bravo']);
        await import('./LogStreamManager');

        typeSearch('bravo');

        await vi.waitFor(() => expect(highlightedLines().length).toBe(2));
        // First match is marked active; count reads "current/total".
        expect(document.querySelectorAll('.log-stream-line.active').length).toBe(1);
        expect(document.getElementById('log-search-count')?.textContent).toBe('1/2');
    });

    it('re-scanning for a new term clears the previous highlights', async () => {
        buildDom(['alpha bravo', 'charlie delta', 'echo bravo']);
        await import('./LogStreamManager');

        typeSearch('bravo');
        await vi.waitFor(() => expect(highlightedLines().length).toBe(2));

        typeSearch('delta');
        await vi.waitFor(() => {
            expect(highlightedLines().length).toBe(1);
            expect(highlightedLines()[0].textContent).toBe('charlie delta');
        });
    });

    it('clearing the term removes all highlights and the count', async () => {
        buildDom(['alpha bravo', 'charlie bravo']);
        await import('./LogStreamManager');

        typeSearch('bravo');
        await vi.waitFor(() => expect(highlightedLines().length).toBe(2));

        typeSearch('');
        await vi.waitFor(() => expect(highlightedLines().length).toBe(0));
        expect(document.getElementById('log-search-count')?.textContent).toBe('');
    });

    it('the close button clears highlights and resets the input', async () => {
        buildDom(['alpha bravo', 'charlie bravo']);
        await import('./LogStreamManager');

        typeSearch('bravo');
        await vi.waitFor(() => expect(highlightedLines().length).toBe(2));

        (document.getElementById('log-search-close') as HTMLButtonElement).click();

        expect(highlightedLines().length).toBe(0);
        expect(document.querySelectorAll('.log-stream-line.active').length).toBe(0);
        expect((document.getElementById('log-search-input') as HTMLInputElement).value).toBe('');
    });
});
