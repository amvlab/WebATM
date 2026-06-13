// @vitest-environment happy-dom
/**
 * Tests for the live "Server Log" tab (integrated build): DOM injection, the
 * seq-ordered/de-duplicated ingest pipeline, the line cap, and tab switching.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { ServerLogBatch, ServerLogLine } from '../data/types';
import { ServerLogStreamManager } from './ServerLogStreamManager';

interface MockSocket {
    on: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
}

type ServerLogListener = (payload: ServerLogBatch) => void;

function buildEchoScaffold(): void {
    document.body.innerHTML = `
        <div class="echo-section">
            <div class="echo-header">
                <div class="echo-tab-bar">
                    <button id="echo-tab-btn" class="echo-tab active">Echo</button>
                    <button id="log-stream-tab-btn" class="echo-tab">Output Log</button>
                </div>
                <div class="echo-header-controls">
                    <span id="log-stream-filename"></span>
                    <button id="clear-echo" class="console-btn">Clear</button>
                    <button id="refresh-output-files" class="console-btn">Reload</button>
                    <button id="clear-log-stream" class="console-btn">Clear</button>
                    <button id="stop-log-stream" class="console-btn">Exit Stream</button>
                </div>
            </div>
            <div class="echo-output" id="echo-output"></div>
            <div id="output-log-container" style="display: none;"></div>
        </div>
    `;
}

function createMockSocket(): MockSocket {
    return { on: vi.fn(), emit: vi.fn() };
}

function byId(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing #${id}`);
    return el;
}

function serverLogListener(socket: MockSocket): ServerLogListener {
    const call = socket.on.mock.calls.find((c) => c[0] === 'server_log');
    if (!call) throw new Error('server_log handler was not registered');
    return call[1] as ServerLogListener;
}

function lines(...seqs: number[]): ServerLogLine[] {
    return seqs.map((seq) => ({ seq, t: 0, line: `line ${seq}` }));
}

function renderedLines(): string[] {
    return Array.from(byId('server-log-output').children).map((c) => c.textContent ?? '');
}

describe('ServerLogStreamManager', () => {
    let socket: MockSocket;
    let manager: ServerLogStreamManager;

    beforeEach(() => {
        buildEchoScaffold();
        socket = createMockSocket();
        manager = new ServerLogStreamManager(socket as unknown as Socket);
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('injects the Server Log tab button and pane into the echo section', () => {
        expect(document.querySelector('.echo-tab-bar #server-log-tab-btn')).not.toBeNull();
        expect(document.querySelector('.echo-section #server-log-output')).not.toBeNull();
        // Controls live inside the pane.
        expect(document.getElementById('bs-start')).not.toBeNull();
        expect(document.getElementById('bs-status')).not.toBeNull();
    });

    it('renders live lines in seq order', () => {
        serverLogListener(socket)({ lines: lines(1, 2, 3) });
        expect(renderedLines()).toEqual(['line 1', 'line 2', 'line 3']);
    });

    it('appends across successive batches', () => {
        const emit = serverLogListener(socket);
        emit({ lines: lines(1, 2) });
        emit({ lines: lines(3, 4) });
        expect(renderedLines()).toEqual(['line 1', 'line 2', 'line 3', 'line 4']);
    });

    it('de-duplicates by seq', () => {
        const emit = serverLogListener(socket);
        emit({ lines: lines(1, 2, 3) });
        emit({ lines: lines(2, 3, 4) });
        expect(renderedLines()).toEqual(['line 1', 'line 2', 'line 3', 'line 4']);
    });

    it('merges an out-of-order history replay into seq order', () => {
        const emit = serverLogListener(socket);
        emit({ lines: lines(5, 6) });
        emit({ lines: lines(1, 2, 5, 6), replay: true });
        expect(renderedLines()).toEqual(['line 1', 'line 2', 'line 5', 'line 6']);
    });

    it('caps the pane at 2000 lines, dropping the oldest', () => {
        const many: ServerLogLine[] = [];
        for (let seq = 1; seq <= 2001; seq++) many.push({ seq, t: 0, line: `line ${seq}` });
        serverLogListener(socket)({ lines: many });

        const out = byId('server-log-output');
        expect(out.children.length).toBe(2000);
        expect(out.children[0].textContent).toBe('line 2');
        expect(out.children[1999].textContent).toBe('line 2001');
    });

    it('activate() shows the pane, hides the others, and requests history exactly once', () => {
        manager.activate();

        expect(byId('server-log-container').style.display).toBe('flex');
        expect(byId('echo-output').style.display).toBe('none');
        expect(byId('output-log-container').style.display).toBe('none');
        expect(byId('server-log-tab-btn').classList.contains('active')).toBe(true);
        expect(byId('echo-tab-btn').classList.contains('active')).toBe(false);

        manager.activate();
        const historyCalls = socket.emit.mock.calls.filter((c) => c[0] === 'request_log_history');
        expect(historyCalls).toHaveLength(1);
    });

    it('hides the pane and deactivates its tab when the Echo tab is clicked', () => {
        manager.activate();
        expect(byId('server-log-container').style.display).toBe('flex');

        byId('echo-tab-btn').dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(byId('server-log-container').style.display).toBe('none');
        expect(byId('server-log-tab-btn').classList.contains('active')).toBe(false);
    });

    it('clear() empties the pane', () => {
        serverLogListener(socket)({ lines: lines(1, 2) });
        expect(byId('server-log-output').children.length).toBe(2);

        manager.clear();
        expect(byId('server-log-output').children.length).toBe(0);
    });
});
