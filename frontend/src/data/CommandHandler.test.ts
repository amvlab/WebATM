/**
 * Tests for CommandHandler command routing: local commands (PAN/ZOOM),
 * preprocessed commands (MCRE/QUIT), and server pass-through. The App and
 * EchoManager are mocked so routing logic is tested in isolation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandHandler } from './CommandHandler';
import { echoManager } from '../ui/EchoManager';
import type { App } from '../core/App';

vi.mock('../ui/EchoManager', () => ({
    echoManager: { addMessage: vi.fn() },
}));

const addMessage = vi.mocked(echoManager.addMessage);

function createAppMock() {
    const mapDisplay = {
        isInitialized: vi.fn(() => true),
        panTo: vi.fn(),
        setZoom: vi.fn(),
        zoomIn: vi.fn(),
        zoomOut: vi.fn(),
        // [west, south, east, north]
        getCurrentBounds: vi.fn(() => [4.0, 52.0, 5.0, 53.0]),
    };
    const stateManager = {
        getState: vi.fn(() => ({
            aircraftData: {
                id: ['KL123', 'AF265'],
                lat: [52.3, 48.8],
                lon: [4.8, 2.3],
                tas: [250, 260],
            },
        })),
    };
    const socketManager = { disconnect: vi.fn() };
    const app = {
        getMapDisplay: () => mapDisplay,
        getStateManager: () => stateManager,
        getSocketManager: () => socketManager,
    } as unknown as App;
    return { app, mapDisplay, stateManager, socketManager };
}

describe('CommandHandler', () => {
    let mocks: ReturnType<typeof createAppMock>;
    let handler: CommandHandler;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks = createAppMock();
        handler = new CommandHandler(mocks.app);
    });

    it('ignores empty input', () => {
        expect(handler.handleCommand('   ')).toEqual({ handled: false, sendToServer: false });
    });

    it('passes unknown commands through to the server', () => {
        expect(handler.handleCommand('HDG KL123 90')).toEqual({ handled: false, sendToServer: true });
    });

    describe('PAN', () => {
        it('pans to comma-separated coordinates', () => {
            const result = handler.handleCommand('PAN 52.3,4.8');
            expect(mocks.mapDisplay.panTo).toHaveBeenCalledWith(52.3, 4.8);
            expect(result).toEqual({ handled: true, sendToServer: false });
        });

        it('pans to space-separated coordinates', () => {
            handler.handleCommand('PAN 52.3 4.8');
            expect(mocks.mapDisplay.panTo).toHaveBeenCalledWith(52.3, 4.8);
        });

        it('pans to an aircraft by case-insensitive callsign', () => {
            handler.handleCommand('PAN af265');
            expect(mocks.mapDisplay.panTo).toHaveBeenCalledWith(48.8, 2.3);
        });

        it('rejects out-of-range coordinates and falls back to callsign lookup', () => {
            const result = handler.handleCommand('PAN 95,200');
            expect(mocks.mapDisplay.panTo).not.toHaveBeenCalled();
            expect(result).toEqual({ handled: true, sendToServer: false });
            expect(addMessage).toHaveBeenCalledWith(
                expect.stringContaining('not found'), 'warning', 'webatm');
        });

        it('warns when called without arguments', () => {
            const result = handler.handleCommand('PAN');
            expect(result).toEqual({ handled: true, sendToServer: false });
            expect(addMessage).toHaveBeenCalledWith(
                expect.stringContaining('requires coordinates'), 'warning', 'webatm');
        });

        it('errors when the map is not initialized', () => {
            mocks.mapDisplay.isInitialized.mockReturnValue(false);
            handler.handleCommand('PAN 52,4');
            expect(addMessage).toHaveBeenCalledWith('Map not initialized', 'error', 'webatm');
        });
    });

    describe('ZOOM', () => {
        it('sets a numeric zoom level', () => {
            const result = handler.handleCommand('ZOOM 8');
            expect(mocks.mapDisplay.setZoom).toHaveBeenCalledWith(8);
            expect(result).toEqual({ handled: true, sendToServer: false });
        });

        it('supports ZOOM IN / ZOOM OUT and ZOOMIN / ZOOMOUT', () => {
            handler.handleCommand('ZOOM IN');
            expect(mocks.mapDisplay.zoomIn).toHaveBeenCalledTimes(1);
            handler.handleCommand('ZOOMOUT');
            expect(mocks.mapDisplay.zoomOut).toHaveBeenCalledTimes(1);
        });

        it('warns on a non-numeric level', () => {
            handler.handleCommand('ZOOM lots');
            expect(mocks.mapDisplay.setZoom).not.toHaveBeenCalled();
            expect(addMessage).toHaveBeenCalledWith(
                expect.stringContaining('Invalid zoom level'), 'warning', 'webatm');
        });
    });

    describe('MCRE', () => {
        it('wraps the command in INSIDE with the current map bounds (south west north east)', () => {
            const result = handler.handleCommand('MCRE 5 A320');
            expect(result.handled).toBe(true);
            expect(result.sendToServer).toBe(true);
            expect(result.modifiedCommand).toBe(
                `INSIDE ${(52).toFixed(14)} ${(4).toFixed(14)} ${(53).toFixed(14)} ${(5).toFixed(14)} MCRE 5 A320`
            );
        });
    });

    describe('QUIT', () => {
        it('disconnects the socket without sending to the server', () => {
            const result = handler.handleCommand('QUIT');
            expect(mocks.socketManager.disconnect).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ handled: true, sendToServer: false });
        });
    });

    it('reports not-yet-implemented local commands as handled', () => {
        const result = handler.handleCommand('SHOWWPT');
        expect(result).toEqual({ handled: true, sendToServer: false });
        expect(addMessage).toHaveBeenCalledWith(
            expect.stringContaining('not yet implemented'), 'warning', 'webatm');
    });

    describe('aircraft type warnings for CRE/MCRE', () => {
        it('warns about types missing from the openap library but still sends', () => {
            const result = handler.handleCommand('CRE KL123 FAKE1 52 4 90 FL100 250');
            expect(result).toEqual({ handled: false, sendToServer: true });
            expect(addMessage).toHaveBeenCalledWith(
                expect.stringContaining('FAKE1'), 'warning', 'webatm');
        });

        it('does not warn for known openap types', () => {
            handler.handleCommand('CRE KL123 A320 52 4 90 FL100 250');
            expect(addMessage).not.toHaveBeenCalled();
        });
    });
});
