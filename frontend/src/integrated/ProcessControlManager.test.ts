// @vitest-environment happy-dom
/**
 * Tests for the integrated server-control buttons: status probe on construction,
 * the REST calls behind each button, and that (re)starting opens the log tab.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProcessControlManager } from './ProcessControlManager';
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

describe('ProcessControlManager', () => {
    let logTab: { activate: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        buildControlDom();
        logTab = { activate: vi.fn() };
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    function makeManager(): ProcessControlManager {
        return new ProcessControlManager(logTab as unknown as ServerLogStreamManager);
    }

    it('probes status on construction and shows running + pid', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: true, running: true, status: 'running', pid: 4242 }),
        });
        vi.stubGlobal('fetch', fetchMock);

        makeManager();

        await vi.waitFor(() => expect(statusText()).toBe('running (pid 4242)'));
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

    it('Start POSTs the start endpoint, surfaces the message, and opens the log tab', async () => {
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

        await vi.waitFor(() => expect(statusText()).toBe('BlueSky server started'));
        expect(fetchMock).toHaveBeenCalledWith('/api/integrated/server/start', { method: 'POST' });
        expect(logTab.activate).toHaveBeenCalledTimes(1);
    });

    it('Stop POSTs the stop endpoint and does NOT open the log tab', async () => {
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

        makeManager();
        await vi.waitFor(() => expect(statusText()).toBe('running (pid 7)'));

        click('stop');

        await vi.waitFor(() => expect(statusText()).toBe('BlueSky server stopped'));
        expect(fetchMock).toHaveBeenCalledWith('/api/integrated/server/stop', { method: 'POST' });
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

    it('auto-connects after a successful Start when a connect hook is provided', async () => {
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

        const autoConnect = vi.fn().mockResolvedValue(true);
        new ProcessControlManager(logTab as unknown as ServerLogStreamManager, autoConnect);
        await vi.waitFor(() => expect(statusText()).toBe('stopped'));

        click('start');

        await vi.waitFor(() => expect(statusText()).toBe('running — connected'));
        expect(autoConnect).toHaveBeenCalledTimes(1);
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

        const autoConnect = vi.fn().mockResolvedValue(false);
        new ProcessControlManager(logTab as unknown as ServerLogStreamManager, autoConnect);
        await vi.waitFor(() => expect(statusText()).toBe('running (pid 9)'));

        click('restart');

        await vi.waitFor(() => expect(autoConnect).toHaveBeenCalledTimes(3));
        expect(statusText()).toContain('auto-connect failed');
        expect(logTab.activate).toHaveBeenCalledTimes(1);
    });

    it('auto-disconnects (and does not connect) on Stop', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string) => {
                if (url.endsWith('/status')) {
                    return Promise.resolve({ ok: true, json: async () => ({ running: true, pid: 3 }) });
                }
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ success: true, status: 'stopped', message: 'BlueSky server stopped' }),
                });
            }),
        );

        const autoConnect = vi.fn().mockResolvedValue(true);
        const autoDisconnect = vi.fn().mockResolvedValue(undefined);
        new ProcessControlManager(
            logTab as unknown as ServerLogStreamManager,
            autoConnect,
            autoDisconnect,
        );
        await vi.waitFor(() => expect(statusText()).toBe('running (pid 3)'));

        click('stop');

        await vi.waitFor(() => expect(autoDisconnect).toHaveBeenCalledTimes(1));
        expect(autoConnect).not.toHaveBeenCalled();
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
            ).toEqual(['BlueSky server started', 'BlueSky server started']),
        );
        expect(fetchMock).toHaveBeenCalledWith('/api/integrated/server/start', { method: 'POST' });
    });
});
