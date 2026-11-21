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

interface StreamResponse {
    success: boolean;
    content: string;
    offset: number;
    total_size: number;
    filename: string;
    error?: string;
}

function streamResponse(content: string, offset: number): StreamResponse {
    return { success: true, content, offset, total_size: offset, filename: 't.log' };
}

function renderedLines(): string[] {
    return Array.from(document.querySelectorAll('.log-stream-line'))
        .map(el => el.textContent ?? '');
}

describe('LogStreamManager streaming line assembly', () => {
    // Queue of pending responses; each fetch call consumes one.
    let responses: Array<Promise<StreamResponse>>;

    function queueResponse(response: StreamResponse): void {
        responses.push(Promise.resolve(response));
    }

    beforeEach(() => {
        vi.resetModules(); // fresh singleton per test
        vi.useFakeTimers();
        responses = [];
        vi.stubGlobal('fetch', vi.fn(() => {
            const next = responses.shift() ?? Promise.resolve(streamResponse('', 0));
            return next.then(result => ({ json: async () => result }));
        }));
        buildDom([]);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('holds a chunk\'s trailing mid-line fragment in one element and completes it in place', async () => {
        const { logStreamManager } = await import('./LogStreamManager');

        // Initial chunk ends mid-line: the writer had not finished "bravo".
        queueResponse(streamResponse('alpha\nbra', 9));
        await logStreamManager.startStreaming('t.log');
        expect(renderedLines()).toEqual(['alpha', 'bra']);

        // The next poll delivers the rest of the line plus a complete one.
        queueResponse(streamResponse('vo\ncharlie\n', 20));
        await vi.advanceTimersByTimeAsync(2000);
        expect(renderedLines()).toEqual(['alpha', 'bravo', 'charlie']);

        logStreamManager.stopStreaming();
    });

    it('does not render phantom empty lines for newline-terminated chunks', async () => {
        const { logStreamManager } = await import('./LogStreamManager');

        queueResponse(streamResponse('one\ntwo\n', 8));
        await logStreamManager.startStreaming('t.log');
        expect(renderedLines()).toEqual(['one', 'two']);

        queueResponse(streamResponse('three\n', 14));
        await vi.advanceTimersByTimeAsync(2000);
        expect(renderedLines()).toEqual(['one', 'two', 'three']);

        logStreamManager.stopStreaming();
    });

    it('discards a late response that arrives after the stream was stopped', async () => {
        const { logStreamManager } = await import('./LogStreamManager');

        let resolveLate: (r: StreamResponse) => void;
        responses.push(new Promise<StreamResponse>(resolve => { resolveLate = resolve; }));

        const started = logStreamManager.startStreaming('t.log');
        logStreamManager.stopStreaming();

        resolveLate!(streamResponse('stale\n', 6));
        await started;

        expect(renderedLines()).toEqual([]);
    });

    it('follows the stream only while the view is at the bottom', async () => {
        const { logStreamManager } = await import('./LogStreamManager');
        const output = document.getElementById('log-stream-output') as HTMLElement;
        // happy-dom does no layout, so give the pane fixed scroll metrics.
        Object.defineProperty(output, 'scrollHeight', { configurable: true, get: () => 1000 });
        Object.defineProperty(output, 'clientHeight', { configurable: true, get: () => 100 });

        queueResponse(streamResponse('one\ntwo\n', 8));
        await logStreamManager.startStreaming('t.log');
        // Initial load is a replace: always lands on the tail.
        expect(output.scrollTop).toBe(1000);

        // The user scrolls up to read; the next poll must not yank them down.
        output.scrollTop = 0;
        queueResponse(streamResponse('three\n', 14));
        await vi.advanceTimersByTimeAsync(2000);
        expect(renderedLines()).toEqual(['one', 'two', 'three']);
        expect(output.scrollTop).toBe(0);

        // Back near the bottom (within the 40px threshold): follow again.
        output.scrollTop = 880;
        queueResponse(streamResponse('four\n', 19));
        await vi.advanceTimersByTimeAsync(2000);
        expect(output.scrollTop).toBe(1000);

        logStreamManager.stopStreaming();
    });

    it('a truncation replace jumps to the tail even when scrolled up', async () => {
        const { logStreamManager } = await import('./LogStreamManager');
        const output = document.getElementById('log-stream-output') as HTMLElement;
        Object.defineProperty(output, 'scrollHeight', { configurable: true, get: () => 1000 });
        Object.defineProperty(output, 'clientHeight', { configurable: true, get: () => 100 });

        queueResponse(streamResponse('old1\nold2\n', 10));
        await logStreamManager.startStreaming('t.log');
        output.scrollTop = 0;

        // Offset moved backwards: the file was rewritten, display replaced.
        queueResponse(streamResponse('new\n', 4));
        await vi.advanceTimersByTimeAsync(2000);
        expect(renderedLines()).toEqual(['new']);
        expect(output.scrollTop).toBe(1000);

        logStreamManager.stopStreaming();
    });

    it('highlights matching lines appended while a search is active and prunes replaced ones', async () => {
        Element.prototype.scrollIntoView = vi.fn();
        const { logStreamManager } = await import('./LogStreamManager');

        // Chunk ends mid-line; both the full and the partial line match.
        queueResponse(streamResponse('bravo one\nbravo tw', 18));
        await logStreamManager.startStreaming('t.log');

        typeSearch('bravo');
        await vi.advanceTimersByTimeAsync(200); // search debounce
        expect(highlightedLines().length).toBe(2);

        // The partial line completes (its old element is replaced) and a new
        // matching line arrives: count stays live, no dead elements counted.
        queueResponse(streamResponse('o\nskip me\nbravo three\n', 40));
        await vi.advanceTimersByTimeAsync(2000);

        expect(renderedLines()).toEqual(['bravo one', 'bravo two', 'skip me', 'bravo three']);
        expect(highlightedLines().length).toBe(3);
        expect(document.getElementById('log-search-count')?.textContent).toBe('1/3');

        logStreamManager.stopStreaming();
    });

    it('drops matches trimmed out by the line cap from the search count', async () => {
        Element.prototype.scrollIntoView = vi.fn();
        const { logStreamManager } = await import('./LogStreamManager');

        queueResponse(streamResponse('bravo a\nbravo b\n', 16));
        await logStreamManager.startStreaming('t.log');

        typeSearch('bravo');
        await vi.advanceTimersByTimeAsync(200);
        expect(document.getElementById('log-search-count')?.textContent).toBe('1/2');

        // 1000 non-matching lines push both matches past the line cap.
        const filler = Array.from({ length: 1000 }, (_, i) => `filler ${i}`).join('\n') + '\n';
        queueResponse(streamResponse(filler, 16 + filler.length));
        await vi.advanceTimersByTimeAsync(2000);

        expect(highlightedLines().length).toBe(0);
        expect(document.getElementById('log-search-count')?.textContent).toBe('No matches');

        logStreamManager.stopStreaming();
    });

    it('replaces the display when the server restarts a truncated file with a fresh tail', async () => {
        const { logStreamManager } = await import('./LogStreamManager');

        queueResponse(streamResponse('old1\nold2\n', 10));
        await logStreamManager.startStreaming('t.log');
        expect(renderedLines()).toEqual(['old1', 'old2']);

        // The file shrank (re-run scenario logging to the same name): the
        // server reset to tail mode and returned an offset below ours.
        queueResponse(streamResponse('new\n', 4));
        await vi.advanceTimersByTimeAsync(2000);
        expect(renderedLines()).toEqual(['new']);

        logStreamManager.stopStreaming();
    });
});
