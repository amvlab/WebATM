// @vitest-environment happy-dom
/**
 * Tests for the integrated server-control buttons: status probe on construction,
 * the REST calls behind each button, auto-connect/disconnect around the
 * lifecycle actions, and reconciliation with the live BlueSky connection.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { ProcessControlManager } from './ProcessControlManager';
import type { ConnectionStateSource } from './ProcessControlManager';
import type { ServerLogStreamManager } from './ServerLogStreamManager';

function buildControlDom(): void {
    document.body.innerHTML = `
        <button data-bs-action="start"></button>
        <button data-bs-action="stop"></button>
        <button data-bs-action="restart"></button>
        <button data-bs-action="kill"></button>
        <span class="bs-status">unknown</span>
    `;
}

function statusText(): string {
    return document.querySelector('.bs-status')?.textContent ?? '';
}

function click(action: string): void {
    document
        .querySelector(`[data-bs-action="${action}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Controllable stand-in for ConnectionStatusService. */
function makeConnState(initial: boolean) {
    let connected = initial;
    let listener: (() => void) | null = null;
    const source: ConnectionStateSource = {
        isBlueSkyConnected: () => connected,
        subscribe: (cb: () => void) => {
            listener = cb;
            return () => {
                listener = null;
            };
        },
    };
    return {
        source,
        flip(value: boolean) {
            connected = value;
            listener?.();
        },
    };
}

describe('ProcessControlManager', () => {
    let logTab: { activate: ReturnType<typeof vi.fn> };
    let autoConnect: Mock<() => Promise<boolean>>;
    let autoDisconnect: Mock<() => Promise<void>>;

    beforeEach(() => {
        buildControlDom();
        logTab = { activate: vi.fn() };
        autoConnect = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
        autoDisconnect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    function makeManager(conn: ConnectionStateSource = makeConnState(false).source): ProcessControlManager {
        return new ProcessControlManager(
            logTab as unknown as ServerLogStreamManager,
            autoConnect,
            autoDisconnect,
            conn,
        );
    }

    it('probes status on construction and folds in the connection state', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: true, running: true, status: 'running', pid: 4242 }),
        });
        vi.stubGlobal('fetch', fetchMock);

        makeManager(makeConnState(true).source);

        await vi.waitFor(() => expect(statusText()).toBe('running — connected'));
        expect(fetchMock).toHaveBeenCalledWith('/api/integrated/server/status');
    });

    it('shows stopped when the status probe reports not running', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ success: true, running: false, status: 'stopped', pid: null }),
            }),
        );

        makeManager();
        await vi.waitFor(() => expect(statusText()).toBe('stopped'));
    });

    it('Start POSTs the start endpoint, opens the log tab, and auto-connects', async () => {
        const fetchMock = vi.fn((url: string) => {
            if (url.endsWith('/status')) {
                return Promise.resolve({ ok: true, json: async () => ({ running: false }) });
            }
            return Promise.resolve({
                ok: true,
                json: async () => ({ success: true, status: 'running', message: 'BlueSky server started' }),
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        makeManager();
        await vi.waitFor(() => expect(statusText()).toBe('stopped')); // initial probe settled

        click('start');

        await vi.waitFor(() => expect(statusText()).toBe('running — connected'));
        expect(fetchMock).toHaveBeenCalledWith('/api/integrated/server/start', { method: 'POST' });
        expect(autoConnect).toHaveBeenCalledTimes(1);
        expect(logTab.activate).toHaveBeenCalledTimes(1);
    });

    it('does not auto-connect when the start request fails', async () => {
        const fetchMock = vi.fn((url: string) => {
            if (url.endsWith('/status')) {
                return Promise.resolve({ ok: true, json: async () => ({ running: false }) });
            }
            return Promise.resolve({
                ok: true,
                json: async () => ({ success: false, status: 'error', message: 'Failed to start BlueSky' }),
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        makeManager();
        await vi.waitFor(() => expect(statusText()).toBe('stopped'));

        click('start');

        await vi.waitFor(() => expect(statusText()).toBe('Failed to start BlueSky'));
        expect(autoConnect).not.toHaveBeenCalled();
        // The log tab still opens so the failure output is visible.
        expect(logTab.activate).toHaveBeenCalledTimes(1);
    });

    it('retries the connect hook on Restart and reports failure after exhausting attempts', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string) => {
                if (url.endsWith('/status')) {
                    return Promise.resolve({ ok: true, json: async () => ({ running: true, pid: 9 }) });
                }
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ success: true, status: 'running', message: 'BlueSky server restarted' }),
                });
            }),
        );

        autoConnect.mockResolvedValue(false);
        makeManager();
        await vi.waitFor(() => expect(statusText()).toBe('running — not connected'));

        click('restart');

        await vi.waitFor(() => expect(autoConnect).toHaveBeenCalledTimes(3));
        expect(statusText()).toContain('auto-connect failed');
        expect(logTab.activate).toHaveBeenCalledTimes(1);
    });

    it('Stop POSTs the stop endpoint, auto-disconnects, and does NOT open the log tab', async () => {
        const fetchMock = vi.fn((url: string) => {
            if (url.endsWith('/status')) {
                return Promise.resolve({ ok: true, json: async () => ({ running: true, pid: 7 }) });
            }
            return Promise.resolve({
                ok: true,
                json: async () => ({ success: true, status: 'stopped', message: 'BlueSky server stopped' }),
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        makeManager(makeConnState(true).source);
        await vi.waitFor(() => expect(statusText()).toBe('running — connected'));

        click('stop');

        await vi.waitFor(() => expect(autoDisconnect).toHaveBeenCalledTimes(1));
        expect(statusText()).toBe('BlueSky server stopped');
        expect(fetchMock).toHaveBeenCalledWith('/api/integrated/server/stop', { method: 'POST' });
        expect(autoConnect).not.toHaveBeenCalled();
        expect(logTab.activate).not.toHaveBeenCalled();
    });

    it('surfaces a "failed" status when the request throws', async () => {
        const fetchMock = vi.fn((url: string) => {
            if (url.endsWith('/status')) {
                return Promise.resolve({ ok: true, json: async () => ({ running: false }) });
            }
            return Promise.reject(new Error('network down'));
        });
        vi.stubGlobal('fetch', fetchMock);

        makeManager();
        await vi.waitFor(() => expect(statusText()).toBe('stopped'));

        click('kill');

        await vi.waitFor(() => expect(statusText()).toBe('kill failed'));
        expect(logTab.activate).not.toHaveBeenCalled();
    });

    it('binds every control surface and mirrors status onto all of them', async () => {
        // A second surface (e.g. the Settings-modal controls) alongside the
        // toolbar fixture: a duplicate action button and status span.
        const second = document.createElement('div');
        second.innerHTML = `
            <button data-bs-action="start"></button>
            <span class="bs-status">unknown</span>
        `;
        document.body.appendChild(second);

        const fetchMock = vi.fn((url: string) => {
            if (url.endsWith('/status')) {
                return Promise.resolve({ ok: true, json: async () => ({ running: false }) });
            }
            return Promise.resolve({
                ok: true,
                json: async () => ({ success: true, status: 'running', message: 'BlueSky server started' }),
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        makeManager();
        // The construction-time probe updates both status spans.
        await vi.waitFor(() =>
            expect(
                Array.from(document.querySelectorAll('.bs-status')).map((el) => el.textContent),
            ).toEqual(['stopped', 'stopped']),
        );

        // Clicking the second surface's button drives the same manager...
        second.querySelector('[data-bs-action="start"]')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        // ...and the resulting status lands on every surface.
        await vi.waitFor(() =>
            expect(
                Array.from(document.querySelectorAll('.bs-status')).map((el) => el.textContent),
            ).toEqual(['running — connected', 'running — connected']),
        );
        expect(fetchMock).toHaveBeenCalledWith('/api/integrated/server/start', { method: 'POST' });
    });

    describe('connection-status reconciliation', () => {
        it('re-probes and re-renders when the live BlueSky connection flips', async () => {
            const conn = makeConnState(true);
            vi.stubGlobal(
                'fetch',
                vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => ({ success: true, running: true, pid: 42 }),
                }),
            );

            makeManager(conn.source);
            await vi.waitFor(() => expect(statusText()).toBe('running — connected'));

            // Connection drops (e.g. after QUIT) while the process keeps running:
            // re-probe -> "running — not connected", never "connected".
            conn.flip(false);
            await vi.waitFor(() => expect(statusText()).toBe('running — not connected'));
        });

        it('shows stopped when the process is gone regardless of connection flips', async () => {
            const conn = makeConnState(false);
            vi.stubGlobal(
                'fetch',
                vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => ({ success: true, running: false, pid: null }),
                }),
            );

            makeManager(conn.source);
            await vi.waitFor(() => expect(statusText()).toBe('stopped'));

            conn.flip(true); // a stray connect signal must not claim "connected"
            await vi.waitFor(() => expect(statusText()).toBe('stopped'));
        });
    });
});
