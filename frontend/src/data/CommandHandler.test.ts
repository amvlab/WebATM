/**
 * Tests for CommandHandler command routing: local commands (PAN/ZOOM),
 * preprocessed commands (MCRE/QUIT), and server pass-through. The App and
 * EchoManager are mocked so routing logic is tested in isolation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommandHandler } from './CommandHandler';
import { LOCAL_COMMAND_SIGNATURES } from './CommandSignature';
import { echoManager } from '../ui/EchoManager';
import { connectionStatus } from '../core/ConnectionStatusService';
import type { App } from '../core/App';

vi.mock('../ui/EchoManager', () => ({
    echoManager: { addMessage: vi.fn() },
}));

vi.mock('../core/ConnectionStatusService', () => ({
    connectionStatus: { setBlueSkyConnected: vi.fn() },
}));

const addMessage = vi.mocked(echoManager.addMessage);
const setBlueSkyConnected = vi.mocked(connectionStatus.setBlueSkyConnected);

function createAppMock() {
    const mapDisplay = {
        isInitialized: vi.fn(() => true),
        panTo: vi.fn(),
        setZoom: vi.fn(),
        zoomIn: vi.fn(),
        zoomOut: vi.fn(),
        getZoom: vi.fn(() => 8),
        getCenter: vi.fn((): [number, number] => [4.5, 52.5]),
        // [west, south, east, north]
        getCurrentBounds: vi.fn(() => [4.0, 52.0, 5.0, 53.0]),
    };
    const displayOptions = {
        showAircraft: true,
        showProtectedZones: false,
        showAircraftLabels: true,
        showAircraftId: true,
        showAircraftType: true,
        showAircraftSpeed: true,
        showAircraftAltitude: true,
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
        getDisplayOptions: vi.fn(() => ({ ...displayOptions })),
    };
    const displayOptionsPanel = {
        // Mirrors the real contract: an explicit value is applied as-is, no
        // value toggles (the mock always "toggles" to true).
        setBooleanOption: vi.fn((_stateKey: string, value?: boolean) => value ?? true),
    };
    const socketManager = { disconnect: vi.fn() };
    const app = {
        getMapDisplay: () => mapDisplay,
        getStateManager: () => stateManager,
        getSocketManager: () => socketManager,
        getDisplayOptionsPanel: () => displayOptionsPanel,
    } as unknown as App;
    return { app, mapDisplay, stateManager, displayOptions, displayOptionsPanel, socketManager };
}

/** Stub global fetch to answer /api/navdata/search with the given results. */
function stubNavdataSearch(results: object[]) {
    const fetchMock = vi.fn(() =>
        Promise.resolve({ json: () => Promise.resolve({ success: true, results }) }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('CommandHandler', () => {
    let mocks: ReturnType<typeof createAppMock>;
    let handler: CommandHandler;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks = createAppMock();
        handler = new CommandHandler(mocks.app);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('ignores empty input', () => {
        expect(handler.handleCommand('   ')).toEqual({ handled: false, sendToServer: false });
    });

    it('passes unknown commands through to the server', () => {
        expect(handler.handleCommand('HDG KL123 90')).toEqual({ handled: false, sendToServer: true });
    });

    it('every handled command has a palette signature entry', () => {
        // Keeps LOCAL_COMMAND_SIGNATURES (command palette) in sync with the
        // commands CommandHandler actually intercepts.
        for (const cmd of handler.getAllHandledCommands()) {
            expect(LOCAL_COMMAND_SIGNATURES, `missing palette signature for ${cmd}`)
                .toHaveProperty(cmd);
        }
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

        it('rejects out-of-range coordinates and falls back to ident lookup', async () => {
            stubNavdataSearch([]);
            const result = handler.handleCommand('PAN 95,200');
            expect(result).toEqual({ handled: true, sendToServer: false });
            await vi.waitFor(() => expect(addMessage).toHaveBeenCalledWith(
                expect.stringContaining('not found'), 'warning', 'webatm'));
            expect(mocks.mapDisplay.panTo).not.toHaveBeenCalled();
        });

        it('pans to an airport/waypoint via the navdata index', async () => {
            stubNavdataSearch([
                { kind: 'airport', ident: 'EHAM', name: 'Amsterdam Schiphol', lat: 52.31, lon: 4.76 },
            ]);
            const result = handler.handleCommand('PAN eham');
            expect(result).toEqual({ handled: true, sendToServer: false });
            await vi.waitFor(() =>
                expect(mocks.mapDisplay.panTo).toHaveBeenCalledWith(52.31, 4.76));
            expect(addMessage).toHaveBeenCalledWith(
                expect.stringContaining('airport EHAM'), 'success', 'webatm');
        });

        it('prefers a matching aircraft over the navdata index', () => {
            const fetchMock = stubNavdataSearch([
                { kind: 'waypoint', ident: 'AF265', name: '', lat: 0, lon: 0 },
            ]);
            handler.handleCommand('PAN AF265');
            expect(mocks.mapDisplay.panTo).toHaveBeenCalledWith(48.8, 2.3);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('ignores navdata results that only prefix-match the ident', async () => {
            stubNavdataSearch([
                { kind: 'airport', ident: 'EHAMX', name: 'Not it', lat: 1, lon: 2 },
            ]);
            handler.handleCommand('PAN EHAM');
            await vi.waitFor(() => expect(addMessage).toHaveBeenCalledWith(
                expect.stringContaining('not found'), 'warning', 'webatm'));
            expect(mocks.mapDisplay.panTo).not.toHaveBeenCalled();
        });

        it('warns instead of throwing when the navdata request fails', async () => {
            vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
            handler.handleCommand('PAN EHAM');
            await vi.waitFor(() => expect(addMessage).toHaveBeenCalledWith(
                expect.stringContaining('not found'), 'warning', 'webatm'));
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
        it('disconnects the proxy from BlueSky (not the browser socket) without sending to the server', () => {
            const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
            vi.stubGlobal('fetch', fetchMock);

            const result = handler.handleCommand('QUIT');

            // Disconnects WebATM's proxy from BlueSky...
            expect(fetchMock).toHaveBeenCalledWith(
                '/api/server/disconnect',
                expect.objectContaining({ method: 'POST' }),
            );
            // ...reflects it immediately in the shared connection status...
            expect(setBlueSkyConnected).toHaveBeenCalledWith(false);
            // ...and crucially does NOT drop the browser↔WebATM socket.
            expect(mocks.socketManager.disconnect).not.toHaveBeenCalled();
            expect(result).toEqual({ handled: true, sendToServer: false });
        });
    });

    it('reports not-yet-implemented local commands as handled', () => {
        const result = handler.handleCommand('FILTERALT');
        expect(result).toEqual({ handled: true, sendToServer: false });
        expect(addMessage).toHaveBeenCalledWith(
            expect.stringContaining('not yet implemented'), 'warning', 'webatm');
    });

    describe('PAN directions', () => {
        it('pans up by half the visible latitude span', () => {
            const result = handler.handleCommand('PAN UP');
            // center [4.5, 52.5], lat span 1 → up = 52.5 + 0.5
            expect(mocks.mapDisplay.panTo).toHaveBeenCalledWith(53.0, 4.5);
            expect(result).toEqual({ handled: true, sendToServer: false });
        });

        it('pans left by half the visible longitude span', () => {
            handler.handleCommand('PAN left');
            expect(mocks.mapDisplay.panTo).toHaveBeenCalledWith(52.5, 4.0);
        });
    });

    describe('+/- zoom shorthand', () => {
        it('zooms in half a level per + or =', () => {
            const result = handler.handleCommand('++');
            expect(mocks.mapDisplay.setZoom).toHaveBeenCalledWith(9);
            expect(result).toEqual({ handled: true, sendToServer: false });
        });

        it('zooms out half a level per -', () => {
            handler.handleCommand('-');
            expect(mocks.mapDisplay.setZoom).toHaveBeenCalledWith(7.5);
        });

        it('combines mixed tokens like BlueSky (+- is net zero, ++- is +0.5)', () => {
            handler.handleCommand('++-');
            expect(mocks.mapDisplay.setZoom).toHaveBeenCalledWith(8.5);
        });
    });

    describe('SHOW* display toggles', () => {
        it.each([
            ['SHOWTRAF', 'showAircraft'],
            ['SHOWPZ', 'showProtectedZones'],
            ['SHOWPOLY', 'showShapes'],
            ['SHOWAPT', 'showAirports'],
            ['SHOWWPT', 'showWaypoints'],
        ])('%s toggles %s without an argument', (cmd, stateKey) => {
            const result = handler.handleCommand(cmd);
            expect(mocks.displayOptionsPanel.setBooleanOption).toHaveBeenCalledWith(stateKey, undefined);
            expect(result).toEqual({ handled: true, sendToServer: false });
        });

        it('applies explicit ON/OFF arguments', () => {
            handler.handleCommand('SHOWTRAF OFF');
            expect(mocks.displayOptionsPanel.setBooleanOption).toHaveBeenCalledWith('showAircraft', false);
            handler.handleCommand('SHOWAPT ON');
            expect(mocks.displayOptionsPanel.setBooleanOption).toHaveBeenCalledWith('showAirports', true);
        });

        it('treats numeric levels as 0 = off, >0 = on', () => {
            handler.handleCommand('SHOWWPT 0');
            expect(mocks.displayOptionsPanel.setBooleanOption).toHaveBeenCalledWith('showWaypoints', false);
            handler.handleCommand('SHOWWPT 2');
            expect(mocks.displayOptionsPanel.setBooleanOption).toHaveBeenCalledWith('showWaypoints', true);
        });

        it('warns on an unparseable argument', () => {
            const result = handler.handleCommand('SHOWTRAF MAYBE');
            expect(mocks.displayOptionsPanel.setBooleanOption).not.toHaveBeenCalled();
            expect(result).toEqual({ handled: true, sendToServer: false });
            expect(addMessage).toHaveBeenCalledWith(
                expect.stringContaining('Invalid argument'), 'warning', 'webatm');
        });
    });

    describe('LABEL', () => {
        it('LABEL 0 switches labels off', () => {
            handler.handleCommand('LABEL 0');
            expect(mocks.displayOptionsPanel.setBooleanOption).toHaveBeenCalledWith('showAircraftLabels', false);
        });

        it('LABEL 1 shows callsign only', () => {
            handler.handleCommand('LABEL 1');
            const calls = mocks.displayOptionsPanel.setBooleanOption.mock.calls;
            expect(calls).toContainEqual(['showAircraftLabels', true]);
            expect(calls).toContainEqual(['showAircraftId', true]);
            expect(calls).toContainEqual(['showAircraftType', false]);
            expect(calls).toContainEqual(['showAircraftSpeed', false]);
            expect(calls).toContainEqual(['showAircraftAltitude', false]);
        });

        it('LABEL 2 shows full detail', () => {
            handler.handleCommand('LABEL 2');
            const calls = mocks.displayOptionsPanel.setBooleanOption.mock.calls;
            expect(calls).toContainEqual(['showAircraftLabels', true]);
            expect(calls).toContainEqual(['showAircraftAltitude', true]);
        });

        it('cycles 2 → 0 without an argument (full detail is level 2)', () => {
            // Mock display options show full labels, i.e. level 2 → next is 0
            handler.handleCommand('LABEL');
            expect(mocks.displayOptionsPanel.setBooleanOption).toHaveBeenCalledWith('showAircraftLabels', false);
        });
    });

    describe('SWRAD', () => {
        it('shows usage without arguments', () => {
            const result = handler.handleCommand('SWRAD');
            expect(result).toEqual({ handled: true, sendToServer: false });
            expect(addMessage).toHaveBeenCalledWith(
                expect.stringContaining('Usage: SWRAD'), 'warning', 'webatm');
        });

        it.each([
            ['SWRAD APT', 'showAirports'],
            ['SWRAD WPT', 'showWaypoints'],
            ['SWRAD POLY', 'showShapes'],
            ['SWRAD TRAIL', 'showAircraftTrails'],
        ])('%s toggles %s', (cmd, stateKey) => {
            handler.handleCommand(cmd);
            expect(mocks.displayOptionsPanel.setBooleanOption).toHaveBeenCalledWith(stateKey, undefined);
        });

        it('SWRAD APT 0 hides airports', () => {
            handler.handleCommand('SWRAD APT 0');
            expect(mocks.displayOptionsPanel.setBooleanOption).toHaveBeenCalledWith('showAirports', false);
        });

        it('SWRAD SYM 2 shows aircraft and protected zones', () => {
            handler.handleCommand('SWRAD SYM 2');
            const calls = mocks.displayOptionsPanel.setBooleanOption.mock.calls;
            expect(calls).toContainEqual(['showAircraft', true]);
            expect(calls).toContainEqual(['showProtectedZones', true]);
        });

        it('SWRAD SYM without a level cycles from the current state', () => {
            // Mock state: aircraft shown, PZ hidden → BlueSky cycles to level 2
            handler.handleCommand('SWRAD SYM');
            const calls = mocks.displayOptionsPanel.setBooleanOption.mock.calls;
            expect(calls).toContainEqual(['showAircraft', true]);
            expect(calls).toContainEqual(['showProtectedZones', true]);
        });

        it('SWRAD LABEL 1 drives the LABEL logic', () => {
            handler.handleCommand('SWRAD LABEL 1');
            const calls = mocks.displayOptionsPanel.setBooleanOption.mock.calls;
            expect(calls).toContainEqual(['showAircraftLabels', true]);
            expect(calls).toContainEqual(['showAircraftSpeed', false]);
        });

        it('explains that GEO/SAT are part of the basemap', () => {
            handler.handleCommand('SWRAD GEO');
            expect(addMessage).toHaveBeenCalledWith(
                expect.stringContaining('basemap'), 'info', 'webatm');
        });

        it('warns on unknown switches', () => {
            handler.handleCommand('SWRAD NOPE');
            expect(addMessage).toHaveBeenCalledWith(
                expect.stringContaining('Unknown SWRAD switch'), 'warning', 'webatm');
        });
    });

    describe('QUIT aliases', () => {
        it.each(['CLOSE', 'END', 'EXIT', 'Q', 'STOP'])('%s behaves like QUIT', (alias) => {
            const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
            vi.stubGlobal('fetch', fetchMock);

            const result = handler.handleCommand(alias);

            expect(fetchMock).toHaveBeenCalledWith(
                '/api/server/disconnect',
                expect.objectContaining({ method: 'POST' }),
            );
            expect(setBlueSkyConnected).toHaveBeenCalledWith(false);
            expect(result).toEqual({ handled: true, sendToServer: false });
        });
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
