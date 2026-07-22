// @vitest-environment happy-dom
/**
 * Characterization tests for the SettingsModal connect flow:
 * - settings load once per open (via the modal's beforeOpen event)
 * - Enter in the host field respects the Connect button's disabled/hidden state
 * - a failed connect recomputes the Connect button state instead of
 *   unconditionally re-enabling it
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./ConsoleManager', () => ({
    consoleManager: {
        error: vi.fn(),
        warning: vi.fn(),
        success: vi.fn(),
        info: vi.fn()
    }
}));

vi.mock('./ModalManager', () => ({
    modalManager: {
        registerModal: vi.fn(),
        on: vi.fn(),
        open: vi.fn(),
        close: vi.fn()
    }
}));

vi.mock('./ServerManager', () => ({
    serverManager: {
        checkServerStatus: vi.fn().mockResolvedValue(undefined),
        getServerStatus: vi.fn(() => 'stopped'),
        resetStatus: vi.fn()
    }
}));

vi.mock('../core/ConnectionStatusService', () => ({
    connectionStatus: {
        subscribe: vi.fn(),
        getStatus: vi.fn(() => ({ blueSkyConnected: false }))
    }
}));

vi.mock('../utils/ThemeManager', () => ({
    themeManager: {
        getPreference: vi.fn(() => 'system'),
        setPreference: vi.fn(),
        subscribe: vi.fn()
    }
}));

import type { ModalEventHandler } from '../data/types';
import { SettingsModal } from './SettingsModal';
import { modalManager } from './ModalManager';
import { consoleManager } from './ConsoleManager';

function buildSettingsDom(): void {
    document.body.innerHTML = `
        <div id="settings-modal">
            <input type="text" id="server-ip-input">
            <button id="connect-server">Connect</button>
            <button id="disconnect-server">Disconnect</button>
            <button id="cancel-server-settings">Cancel</button>
            <button id="check-server-status">Check Status</button>
            <select id="map-style-select-modal"><option value="default">Default</option></select>
            <input type="text" id="maptiler-api-key-input">
            <select id="log-level-select"><option value="1">Info</option></select>
            <input type="checkbox" id="log-timestamps">
            <input type="checkbox" id="log-component-prefixes">
            <button id="reset-logging-btn">Reset</button>
            <button id="developer-toggle">Dev</button>
            <select id="theme-select"><option value="system">System</option></select>
        </div>
    `;
}

function mockFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/server/config' && init?.method === 'POST') {
            return {
                ok: true,
                json: async () => ({ success: false, error: 'no server' })
            };
        }
        return {
            ok: true,
            json: async () => ({ server_ip: 'localhost' })
        };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function configGetCount(fetchMock: ReturnType<typeof vi.fn>): number {
    return fetchMock.mock.calls.filter(
        ([url, init]) => url === '/api/server/config' && (init as RequestInit | undefined)?.method !== 'POST'
    ).length;
}

function connectPostCount(fetchMock: ReturnType<typeof vi.fn>): number {
    return fetchMock.mock.calls.filter(
        ([url, init]) => url === '/api/server/config' && (init as RequestInit | undefined)?.method === 'POST'
    ).length;
}

function pressEnter(input: HTMLInputElement): void {
    input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));
}

async function flushAsync(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SettingsModal connect flow', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    let beforeOpenCallback: ModalEventHandler | undefined;
    let modal: SettingsModal;

    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        buildSettingsDom();
        fetchMock = mockFetch();
        vi.mocked(modalManager.on).mockImplementation(
            (_id: string, cb: ModalEventHandler) => {
                beforeOpenCallback = cb;
            }
        );
        modal = new SettingsModal();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    it('open() defers settings loading to beforeOpen, so one open loads once', async () => {
        modal.open();
        expect(modalManager.open).toHaveBeenCalledWith('settings-modal');
        // open() itself must not fetch; the modal manager's beforeOpen does.
        expect(configGetCount(fetchMock)).toBe(0);

        beforeOpenCallback?.('beforeOpen', 'settings-modal');
        await flushAsync();
        expect(configGetCount(fetchMock)).toBe(1);
    });

    it('Enter in the host field does not connect while Connect is disabled', () => {
        const input = document.getElementById('server-ip-input') as HTMLInputElement;
        const connect = document.getElementById('connect-server') as HTMLButtonElement;

        connect.disabled = true;
        pressEnter(input);
        expect(connectPostCount(fetchMock)).toBe(0);
    });

    it('Enter in the host field does not connect while Connect is hidden', () => {
        const input = document.getElementById('server-ip-input') as HTMLInputElement;
        const connect = document.getElementById('connect-server') as HTMLButtonElement;

        connect.disabled = false;
        connect.style.display = 'none';
        pressEnter(input);
        expect(connectPostCount(fetchMock)).toBe(0);
    });

    it('Enter connects when Connect is enabled and visible', async () => {
        const input = document.getElementById('server-ip-input') as HTMLInputElement;
        const connect = document.getElementById('connect-server') as HTMLButtonElement;

        connect.disabled = false;
        input.value = '10.0.0.9';
        pressEnter(input);

        expect(connectPostCount(fetchMock)).toBe(1);
        await flushAsync();
        expect(vi.mocked(consoleManager.error)).toHaveBeenCalledWith(
            'Connection failed: no server'
        );
    });

    it('a failed connect leaves Connect disabled when the server is down', async () => {
        const input = document.getElementById('server-ip-input') as HTMLInputElement;
        const connect = document.getElementById('connect-server') as HTMLButtonElement;

        // Server reported running -> Connect enabled
        document.dispatchEvent(
            new CustomEvent('serverStatusUpdate', {
                detail: { status: 'running', message: 'up' }
            })
        );
        expect(connect.disabled).toBe(false);

        pressEnter(input);
        expect(connect.textContent).toBe('Connecting...');

        // The server dies while the connect attempt is in flight
        document.dispatchEvent(
            new CustomEvent('serverStatusUpdate', {
                detail: { status: 'stopped', message: 'down' }
            })
        );

        await flushAsync();
        expect(connect.textContent).toBe('Connect');
        // Regression: the finally block used to re-enable unconditionally
        expect(connect.disabled).toBe(true);
    });

    it('a failed connect re-enables Connect when the server is still up', async () => {
        const input = document.getElementById('server-ip-input') as HTMLInputElement;
        const connect = document.getElementById('connect-server') as HTMLButtonElement;

        document.dispatchEvent(
            new CustomEvent('serverStatusUpdate', {
                detail: { status: 'running', message: 'up' }
            })
        );
        pressEnter(input);

        await flushAsync();
        expect(connect.textContent).toBe('Connect');
        expect(connect.disabled).toBe(false);
    });
});
