// @vitest-environment happy-dom
/**
 * Tests for the connection-state machine: WebSocket/BlueSky transitions,
 * the data-timeout disconnect detection, disconnect callbacks, and the
 * initial-connection check. EchoManager is mocked; timers are faked so
 * the 5s data timeout is testable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConnectionStatusService } from './ConnectionStatusService';
import { echoManager } from '../ui/EchoManager';

vi.mock('../ui/EchoManager', () => ({
    echoManager: {
        success: vi.fn(),
        error: vi.fn(),
        warning: vi.fn(),
        info: vi.fn(),
    },
}));

/**
 * The service is a singleton created at import time; drop the static
 * instance so each test gets a fresh state machine.
 */
function freshService(): ConnectionStatusService {
    (ConnectionStatusService as unknown as { instance: unknown }).instance = null;
    return ConnectionStatusService.getInstance();
}

describe('ConnectionStatusService', () => {
    let service: ConnectionStatusService;

    beforeEach(() => {
        vi.useFakeTimers();
        sessionStorage.clear();
        vi.clearAllMocks();
        service = freshService();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('subscribe', () => {
        it('immediately calls a new listener with the current status', () => {
            const listener = vi.fn();
            service.subscribe(listener);
            expect(listener).toHaveBeenCalledTimes(1);
            expect(listener.mock.calls[0][0].webSocketConnected).toBe(false);
        });

        it('stops notifying after unsubscribe', () => {
            const listener = vi.fn();
            const unsubscribe = service.subscribe(listener);
            listener.mockClear();

            unsubscribe();
            service.setWebSocketConnected(true);
            expect(listener).not.toHaveBeenCalled();
        });

        it('a throwing listener does not block others', () => {
            service.subscribe(() => { throw new Error('boom'); });
            const good = vi.fn();
            service.subscribe(good);
            good.mockClear();

            service.setWebSocketConnected(true);
            expect(good).toHaveBeenCalledTimes(1);
        });
    });

    describe('WebSocket state', () => {
        it('transitions to connected and echoes', () => {
            service.setWebSocketConnected(true);
            const status = service.getStatus();
            expect(status.webSocketConnected).toBe(true);
            expect(status.webSocketState).toBe('connected');
            expect(echoManager.success).toHaveBeenCalledWith('Connected to WebATM server');
        });

        it('does not re-notify when set to the same value', () => {
            service.setWebSocketConnected(true);
            const listener = vi.fn();
            service.subscribe(listener);
            listener.mockClear();

            service.setWebSocketConnected(true);
            expect(listener).not.toHaveBeenCalled();
        });

        it('a WebSocket disconnect forces BlueSky disconnected too', () => {
            service.setWebSocketConnected(true);
            service.onSimInfoReceived(); // BlueSky up

            service.setWebSocketConnected(false);
            expect(service.isBlueSkyConnected()).toBe(false);
            expect(service.isFullyConnected()).toBe(false);
        });
    });

    describe('BlueSky state via data reception', () => {
        it('any data type marks BlueSky connected', () => {
            service.onNodeInfoReceived();
            expect(service.isBlueSkyConnected()).toBe(true);
        });

        it('siminfo/acdata also mark receivingData', () => {
            service.onNodeInfoReceived();
            expect(service.isReceivingData()).toBe(false);

            service.onSimInfoReceived();
            expect(service.isReceivingData()).toBe(true);
        });

        it('drops the connection when no data arrives for 5 seconds', () => {
            service.onSimInfoReceived();
            expect(service.isBlueSkyConnected()).toBe(true);

            vi.advanceTimersByTime(5000);

            expect(service.isBlueSkyConnected()).toBe(false);
            expect(service.isReceivingData()).toBe(false);
            expect(echoManager.warning).toHaveBeenCalledWith(
                expect.stringContaining('No data received'));
        });

        it('continuous data keeps the connection alive past the timeout window', () => {
            service.onSimInfoReceived();
            for (let i = 0; i < 5; i++) {
                vi.advanceTimersByTime(3000);
                service.onAircraftDataReceived();
            }
            expect(service.isBlueSkyConnected()).toBe(true);
        });

        it('tracks the nodeinfo interval for connection quality', () => {
            expect(service.getConnectionQuality()).toBe('unknown');

            service.onNodeInfoReceived();
            vi.advanceTimersByTime(500);
            service.onNodeInfoReceived();
            expect(service.getConnectionQuality()).toBe('excellent');

            vi.advanceTimersByTime(1500);
            service.onNodeInfoReceived();
            expect(service.getConnectionQuality()).toBe('good');

            vi.advanceTimersByTime(3000);
            service.onNodeInfoReceived();
            expect(service.getConnectionQuality()).toBe('poor');
        });
    });

    describe('disconnect callbacks', () => {
        it('fires on a connected -> disconnected transition after initial load', () => {
            // Mark the initial load as already complete (as a reloaded page would)
            sessionStorage.setItem('bluesky-initial-load-complete', 'true');
            service = freshService();

            const callback = vi.fn();
            service.onBlueSkyDisconnect(callback);

            service.onSimInfoReceived();
            expect(callback).not.toHaveBeenCalled();

            vi.advanceTimersByTime(5000); // data timeout
            expect(callback).toHaveBeenCalledWith(false);
        });

        it('does not fire during the initial page load', () => {
            const callback = vi.fn();
            service.onBlueSkyDisconnect(callback);

            service.onSimInfoReceived();
            vi.advanceTimersByTime(5000);
            expect(callback).not.toHaveBeenCalled();
        });
    });

    describe('status strings', () => {
        it('describes each connection tier', () => {
            expect(service.getStatusString()).toContain('Disconnected from WebATM');

            service.setWebSocketConnected(true);
            expect(service.getStatusString()).toContain('Disconnected from BlueSky');

            service.setServerIP('10.0.0.5');
            service.onNodeInfoReceived(); // connected, no data
            expect(service.getStatusString()).toBe(
                'Connected to BlueSky server at 10.0.0.5 (No Data).');

            service.onSimInfoReceived();
            expect(service.getStatusString()).toBe(
                'Connected to BlueSky server at 10.0.0.5.');
        });
    });

    describe('reset', () => {
        it('clears connection state but preserves the server IP', () => {
            service.setServerIP('10.0.0.5');
            service.setWebSocketConnected(true);
            service.onSimInfoReceived();

            service.reset();

            const status = service.getStatus();
            expect(status.webSocketConnected).toBe(false);
            expect(status.blueSkyConnected).toBe(false);
            expect(status.receivingData).toBe(false);
            expect(status.serverIP).toBe('10.0.0.5');
        });

        it('cancels the pending data timeout', () => {
            service.onSimInfoReceived();
            service.reset();

            (echoManager.warning as ReturnType<typeof vi.fn>).mockClear();
            vi.advanceTimersByTime(10000);
            expect(echoManager.warning).not.toHaveBeenCalled();
        });
    });

    describe('initial connection check', () => {
        it('calls onNotConnected after the delay when BlueSky never connects', () => {
            const onNotConnected = vi.fn();
            service.startInitialConnectionCheck(onNotConnected);

            vi.advanceTimersByTime(500);
            expect(onNotConnected).toHaveBeenCalledTimes(1);
            expect(sessionStorage.getItem('bluesky-initial-load-complete')).toBe('true');
        });

        it('does not call onNotConnected when BlueSky connects before the delay', () => {
            const onNotConnected = vi.fn();
            service.startInitialConnectionCheck(onNotConnected);

            service.onNodeInfoReceived();
            vi.advanceTimersByTime(500);
            expect(onNotConnected).not.toHaveBeenCalled();
        });

        it('skips the check entirely on a non-initial load', () => {
            sessionStorage.setItem('bluesky-initial-load-complete', 'true');
            service = freshService();

            const onNotConnected = vi.fn();
            service.startInitialConnectionCheck(onNotConnected);
            vi.advanceTimersByTime(500);
            expect(onNotConnected).not.toHaveBeenCalled();
        });
    });
});
