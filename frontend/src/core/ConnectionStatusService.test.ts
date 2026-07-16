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
import { logger } from '../utils/Logger';

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

    describe('data timeout resilience to main-thread stalls', () => {
        // A setTimeout fires "late" when the event loop was blocked (a heavy
        // synchronous task, GC pause, or backgrounded tab). Fake timers always
        // fire on schedule, so we drive Date.now() directly to simulate the
        // wall-clock overshoot the production code measures.
        it('defers the disconnect when the timeout fires long after its delay', () => {
            const nowSpy = vi.spyOn(Date, 'now');
            nowSpy.mockReturnValue(1000);
            service.onSimInfoReceived(); // armed at t=1000
            expect(service.isBlueSkyConnected()).toBe(true);

            // Callback runs 9s of wall-clock later (a 4s overshoot on a 5s timer).
            nowSpy.mockReturnValue(10000);
            vi.advanceTimersByTime(5000);

            // Stall detected -> connection preserved, no false alarm.
            expect(service.isBlueSkyConnected()).toBe(true);
            expect(echoManager.warning).not.toHaveBeenCalledWith(
                expect.stringContaining('No data received'));
        });

        it('still disconnects once the stall clears and data really is absent', () => {
            const nowSpy = vi.spyOn(Date, 'now');
            nowSpy.mockReturnValue(1000);
            service.onSimInfoReceived();

            // First fire is late -> deferred.
            nowSpy.mockReturnValue(10000);
            vi.advanceTimersByTime(5000);
            expect(service.isBlueSkyConnected()).toBe(true);

            // Re-armed at t=10000; next fire is on schedule (no overshoot) and
            // no data arrived -> a genuine disconnect.
            nowSpy.mockReturnValue(15000);
            vi.advanceTimersByTime(5000);
            expect(service.isBlueSkyConnected()).toBe(false);
        });

        it('live data during the deferral window keeps the connection up', () => {
            const nowSpy = vi.spyOn(Date, 'now');
            nowSpy.mockReturnValue(1000);
            service.onSimInfoReceived();

            nowSpy.mockReturnValue(10000);
            vi.advanceTimersByTime(5000); // deferred, still connected

            // Buffered data is processed now that the thread is free; it
            // re-arms the timer from this moment.
            nowSpy.mockReturnValue(10500);
            service.onAircraftDataReceived();

            // Less than a full window after that data -> still connected.
            nowSpy.mockReturnValue(13000);
            vi.advanceTimersByTime(2500);
            expect(service.isBlueSkyConnected()).toBe(true);
        });

        it('bounds deferrals so a persistent stall still reports an outage', () => {
            const nowSpy = vi.spyOn(Date, 'now');
            let now = 1000;
            nowSpy.mockImplementation(() => now);
            service.onSimInfoReceived();

            // Every fire overshoots; after MAX_STALL_DEFERRALS (2) the third
            // fire gives up and disconnects.
            for (let i = 0; i < 3; i++) {
                now += 9000;
                vi.advanceTimersByTime(5000);
            }
            expect(service.isBlueSkyConnected()).toBe(false);
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

        it('does nothing when BlueSky is already connected at check time', () => {
            // Regression: the early-connection listener used to reference its
            // own `unsubscribe` binding during subscribe()'s synchronous
            // initial call, throwing a (swallowed) TDZ ReferenceError and
            // leaking the subscription when already connected.
            const errorSpy = vi.spyOn(logger, 'error');
            service.onNodeInfoReceived(); // BlueSky connected

            const onNotConnected = vi.fn();
            service.startInitialConnectionCheck(onNotConnected);
            vi.advanceTimersByTime(500);

            expect(onNotConnected).not.toHaveBeenCalled();
            expect(errorSpy).not.toHaveBeenCalled();
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
