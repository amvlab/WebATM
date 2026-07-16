import type { App } from '../core/App';
import type { MapDisplay } from '../ui/map/MapDisplay';
import type { DisplayOptions } from './types';
import { connectionStatus } from '../core/ConnectionStatusService';
import { echoManager } from '../ui/EchoManager';
import { logger } from '../utils/Logger';
import { isOpenapAircraftType } from './aircraftTypes';
import { searchNavdata } from './navdataSearch';

/**
 * Result of command processing
 */
export interface CommandResult {
    /** Whether the command was handled by this handler */
    handled: boolean;
    /** Whether the command should be sent to the BlueSky server */
    sendToServer: boolean;
    /** Modified command to send (if different from original) */
    modifiedCommand?: string;
}

/**
 * CommandHandler processes commands before they are sent to the server.
 * It handles:
 * 1. Local commands that are executed client-side only (PAN, ZOOM, etc.)
 * 2. Commands that need preprocessing before sending to server (MCRE with bbox)
 * 3. Commands that need special client-side handling (QUIT)
 */
export class CommandHandler {
    private app: App;

    /**
     * List of commands that are handled locally and never sent to server
     */
    private readonly LOCAL_COMMANDS = [
        'PAN',
        'ZOOM',
        'ZOOMIN',
        'ZOOMOUT',
        'SWRAD',
        'SHOWWPT',
        'SHOWAPT',
        'SHOWPOLY',
        'SHOWPZ',
        'SHOWTRAF',
        'LABEL',
        'FILTERALT'
    ];

    /**
     * List of commands that need preprocessing before sending to server
     */
    private readonly PREPROCESSED_COMMANDS = [
        'MCRE',
        'QUIT'
    ];

    /**
     * BlueSky's GUI registers QUIT with these aliases (see
     * bluesky/ui/qtgl/mainwindow.py); intercept them the same way so none of
     * them reaches the server. Kept out of getAllHandledCommands() so
     * autocomplete only offers the canonical QUIT.
     */
    private static readonly QUIT_ALIASES = ['CLOSE', 'END', 'EXIT', 'Q', 'STOP'];

    /**
     * SHOW* display-toggle commands (mirroring BlueSky's GUI commands of the
     * same names) → the DisplayOptions flag they drive and a label for echo
     * feedback.
     */
    private static readonly SHOW_COMMAND_OPTIONS: Readonly<Record<string, {
        stateKey: keyof DisplayOptions;
        label: string;
    }>> = {
        SHOWTRAF: { stateKey: 'showAircraft', label: 'Aircraft' },
        SHOWPZ: { stateKey: 'showProtectedZones', label: 'Protected zones' },
        SHOWPOLY: { stateKey: 'showShapes', label: 'Shapes' },
        SHOWAPT: { stateKey: 'showAirports', label: 'Airports' },
        SHOWWPT: { stateKey: 'showWaypoints', label: 'Waypoints' }
    };

    constructor(app: App) {
        this.app = app;
    }

    /**
     * All commands handled by this CommandHandler — the single source of
     * truth the console merges into its autocomplete list.
     */
    public getAllHandledCommands(): string[] {
        return [...this.LOCAL_COMMANDS, ...this.PREPROCESSED_COMMANDS];
    }

    /**
     * Main entry point for command processing
     * @param command The raw command string from the console
     * @returns CommandResult indicating how to handle the command
     */
    public handleCommand(command: string): CommandResult {
        const trimmed = command.trim();
        if (!trimmed) {
            return { handled: false, sendToServer: false };
        }

        // Parse command and arguments
        const parts = trimmed.split(/\s+/);
        let cmd = parts[0].toUpperCase();
        const args = parts.slice(1).join(' ');

        // BlueSky console shorthand: a token of +/= zooms in, - zooms out
        // (one sqrt(2) step per character, mirroring bluesky's clientstack)
        if (/^[+=-]+$/.test(cmd)) {
            return this.handleZoomShorthand(cmd);
        }

        // Map BlueSky's GUI quit aliases onto QUIT
        if (CommandHandler.QUIT_ALIASES.includes(cmd)) {
            cmd = 'QUIT';
        }

        // Warn (non-blocking) if CRE/MCRE uses a type not in the openap list,
        // mirroring the warning shown in the Create Aircraft modal.
        if (cmd === 'CRE' || cmd === 'MCRE') {
            this.warnIfUnknownAircraftType(parts);
        }

        // Check if it's a local command
        if (this.LOCAL_COMMANDS.includes(cmd)) {
            return this.handleLocalCommand(cmd, args);
        }

        // Check if it needs preprocessing
        if (this.PREPROCESSED_COMMANDS.includes(cmd)) {
            return this.handlePreprocessedCommand(cmd, args);
        }

        // Not handled by this handler, pass through to server
        return { handled: false, sendToServer: true };
    }

    /**
     * Handle local commands that execute only on client
     */
    private handleLocalCommand(cmd: string, args: string): CommandResult {
        switch (cmd) {
            case 'PAN':
                return this.handlePanCommand(args);
            case 'ZOOM':
                return this.handleZoomCommand(args);
            case 'ZOOMIN':
                return this.handleZoomInCommand();
            case 'ZOOMOUT':
                return this.handleZoomOutCommand();
            case 'SHOWWPT':
            case 'SHOWAPT':
            case 'SHOWPOLY':
            case 'SHOWPZ':
            case 'SHOWTRAF':
                return this.handleShowToggleCommand(cmd, args);
            case 'LABEL':
                return this.handleLabelCommand(args);
            case 'SWRAD':
                return this.handleSwradCommand(args);
            case 'FILTERALT':
                return this.handleNotImplemented(cmd);
            default:
                return { handled: false, sendToServer: false };
        }
    }

    /**
     * Handle commands that need preprocessing before sending to server
     */
    private handlePreprocessedCommand(cmd: string, args: string): CommandResult {
        switch (cmd) {
            case 'MCRE':
                return this.handleMcreCommand(args);
            case 'QUIT':
                return this.handleQuitCommand();
            default:
                return { handled: false, sendToServer: true };
        }
    }

    /**
     * Handle PAN command - pan map to coordinates, an aircraft, an
     * airport/waypoint, or a direction
     * Usage: PAN <lat>,<lon> or PAN <lat> <lon> or PAN <aircraft_id>
     *        or PAN <airport/waypoint ident> (e.g., PAN EHAM)
     *        or PAN LEFT/RIGHT/UP/DOWN (half a screen, like BlueSky's GUI)
     */
    private handlePanCommand(args: string): CommandResult {
        if (!args || args.trim().length === 0) {
            this.sendEcho('PAN command requires coordinates (e.g., PAN 52.3,4.8), an aircraft ID (e.g., PAN AF265), an airport/waypoint (e.g., PAN EHAM), or LEFT/RIGHT/UP/DOWN', 'warning');
            return { handled: true, sendToServer: false };
        }

        const mapDisplay = this.requireMapInitialized();
        if (!mapDisplay) {
            return { handled: true, sendToServer: false };
        }

        // Directional pan (BlueSky: PAN LEFT/RIGHT/UP/DOWN)
        const direction = args.trim().toUpperCase();
        if (['LEFT', 'RIGHT', 'UP', 'DOWN'].includes(direction)) {
            return this.handlePanDirection(direction, mapDisplay);
        }

        // Try to parse as coordinates first (format: "lat,lon" or "lat lon")
        const coords = this.parseLatLonCoordinates(args);
        if (coords) {
            // Pan to coordinates
            mapDisplay.panTo(coords.lat, coords.lon);
            this.sendEcho(`Panned to ${coords.lat.toFixed(3)}, ${coords.lon.toFixed(3)}`, 'success');
            return { handled: true, sendToServer: false };
        }

        // Try as aircraft ID (case-insensitive); aircraft win over navaids
        const aircraftData = this.app.getStateManager().getState().aircraftData;
        const upperArgs = args.trim().toUpperCase();
        const index = aircraftData?.id
            ? aircraftData.id.findIndex(id => id.toUpperCase() === upperArgs)
            : -1;

        if (index !== -1 && aircraftData) {
            mapDisplay.panTo(aircraftData.lat[index], aircraftData.lon[index]);
            this.sendEcho(`Panned to aircraft ${aircraftData.id[index]}`, 'success');
            return { handled: true, sendToServer: false };
        }

        // Fall back to the navdata index (airports/heliports/waypoints).
        // Async: the command is already handled, the pan follows when the
        // lookup resolves.
        void this.panToNavaid(args.trim(), mapDisplay);
        return { handled: true, sendToServer: false };
    }

    /**
     * Resolve an airport/heliport/waypoint ident via the navdata search
     * index and pan to it. The index orders exact-ident matches first with
     * airports ahead of waypoints, so a duplicate ident resolves to the
     * airport. Echoes a warning when nothing matches.
     */
    private async panToNavaid(ident: string, mapDisplay: MapDisplay): Promise<void> {
        let exact;
        try {
            const results = await searchNavdata(ident, 5);
            const upper = ident.toUpperCase();
            exact = results.find(r => r.ident.toUpperCase() === upper);
        } catch (err) {
            logger.warn('CommandHandler', 'PAN navdata lookup failed:', err);
        }

        if (!exact) {
            this.sendEcho(`PAN: ${ident} not found (no matching aircraft, airport or waypoint)`, 'warning');
            return;
        }

        mapDisplay.panTo(exact.lat, exact.lon);
        const name = exact.name ? ` (${exact.name})` : '';
        this.sendEcho(`Panned to ${exact.kind} ${exact.ident}${name}`, 'success');
    }

    /**
     * Handle ZOOM command - set specific zoom level
     * Usage: ZOOM <level> or ZOOM IN or ZOOM OUT
     */
    private handleZoomCommand(args: string): CommandResult {
        if (!args || args.trim().length === 0) {
            this.sendEcho('ZOOM command requires a level (e.g., ZOOM 8) or IN/OUT', 'warning');
            return { handled: true, sendToServer: false };
        }

        const mapDisplay = this.requireMapInitialized();
        if (!mapDisplay) {
            return { handled: true, sendToServer: false };
        }

        const upperArgs = args.trim().toUpperCase();

        // Handle ZOOM IN / ZOOM OUT
        if (upperArgs === 'IN') {
            return this.handleZoomInCommand();
        }
        if (upperArgs === 'OUT') {
            return this.handleZoomOutCommand();
        }

        // Try to parse as zoom level
        const level = parseFloat(args);
        if (isNaN(level)) {
            this.sendEcho('Invalid zoom level. Use a number, IN, or OUT', 'warning');
            return { handled: true, sendToServer: false };
        }

        mapDisplay.setZoom(level);
        this.sendEcho(`Zoom set to ${level.toFixed(1)}`, 'success');

        return { handled: true, sendToServer: false };
    }

    /**
     * Handle ZOOMIN command - zoom in one level
     */
    private handleZoomInCommand(): CommandResult {
        const mapDisplay = this.requireMapInitialized();
        if (!mapDisplay) {
            return { handled: true, sendToServer: false };
        }

        mapDisplay.zoomIn();
        this.sendEcho('Zoomed in', 'success');

        return { handled: true, sendToServer: false };
    }

    /**
     * Handle ZOOMOUT command - zoom out one level
     */
    private handleZoomOutCommand(): CommandResult {
        const mapDisplay = this.requireMapInitialized();
        if (!mapDisplay) {
            return { handled: true, sendToServer: false };
        }

        mapDisplay.zoomOut();
        this.sendEcho('Zoomed out', 'success');

        return { handled: true, sendToServer: false };
    }

    /**
     * Pan half the visible span in a screen direction (BlueSky: PAN LEFT/...)
     */
    private handlePanDirection(direction: string, mapDisplay: MapDisplay): CommandResult {
        const bounds = mapDisplay.getCurrentBounds();
        if (!bounds || bounds.length !== 4) {
            this.sendEcho('Unable to get map bounds', 'error');
            return { handled: true, sendToServer: false };
        }

        const [west, south, east, north] = bounds;
        const latStep = (north - south) / 2;
        const lonStep = (east - west) / 2;

        const [lon, lat] = mapDisplay.getCenter();
        let newLat = lat;
        let newLon = lon;
        switch (direction) {
            case 'UP': newLat += latStep; break;
            case 'DOWN': newLat -= latStep; break;
            case 'LEFT': newLon -= lonStep; break;
            case 'RIGHT': newLon += lonStep; break;
        }
        newLat = Math.max(-90, Math.min(90, newLat));

        mapDisplay.panTo(newLat, newLon);
        this.sendEcho(`Panned ${direction.toLowerCase()}`, 'success');

        return { handled: true, sendToServer: false };
    }

    /**
     * Handle BlueSky's +/- console shorthand: each + or = zooms in one
     * sqrt(2) step, each - zooms out one. On MapLibre's log2 zoom scale a
     * sqrt(2) factor is 0.5 zoom levels.
     */
    private handleZoomShorthand(token: string): CommandResult {
        const mapDisplay = this.requireMapInitialized();
        if (!mapDisplay) {
            return { handled: true, sendToServer: false };
        }

        let steps = 0;
        for (const ch of token) {
            steps += ch === '-' ? -1 : 1;
        }

        const newZoom = mapDisplay.getZoom() + 0.5 * steps;
        mapDisplay.setZoom(newZoom);
        this.sendEcho(`Zoom set to ${newZoom.toFixed(1)}`, 'success');

        return { handled: true, sendToServer: false };
    }

    /**
     * Handle the SHOW* display toggles (SHOWTRAF, SHOWPZ, SHOWPOLY, SHOWAPT,
     * SHOWWPT). Without an argument the option is toggled; with ON/OFF or a
     * number (BlueSky uses 0/1/2 detail levels for some) it is set.
     */
    private handleShowToggleCommand(cmd: string, args: string): CommandResult {
        const { stateKey, label } = CommandHandler.SHOW_COMMAND_OPTIONS[cmd];

        const flag = this.parseToggleFlag(args.trim().split(/\s+/)[0] || '');
        if (flag === null) {
            this.sendEcho(`Invalid argument for ${cmd}. Use ON/OFF, or no argument to toggle`, 'warning');
            return { handled: true, sendToServer: false };
        }

        const applied = this.setDisplayOption(stateKey, flag);
        if (applied !== null) {
            this.sendEcho(`${label} ${applied ? 'shown' : 'hidden'}`, 'success');
        }

        return { handled: true, sendToServer: false };
    }

    /**
     * Handle LABEL command - cycle or set the aircraft label detail level,
     * mirroring BlueSky's LABEL 0/1/2:
     *   0 = labels off, 1 = callsign only, 2 = full detail
     * Without an argument the level cycles 0 → 1 → 2 → 0.
     */
    private handleLabelCommand(args: string): CommandResult {
        const arg = args.trim().split(/\s+/)[0] || '';
        const upper = arg.toUpperCase();

        let level: number;
        if (!arg) {
            level = (this.currentLabelLevel() + 1) % 3;
        } else if (upper === 'ON' || upper === 'TRUE' || upper === 'YES') {
            level = 2;
        } else if (upper === 'OFF' || upper === 'FALSE' || upper === 'NO') {
            level = 0;
        } else {
            const parsed = parseInt(arg, 10);
            if (isNaN(parsed)) {
                this.sendEcho('Invalid argument for LABEL. Use 0 (off), 1 (callsign), 2 (full), or no argument to cycle', 'warning');
                return { handled: true, sendToServer: false };
            }
            level = Math.max(0, Math.min(2, parsed));
        }

        if (level === 0) {
            this.setDisplayOption('showAircraftLabels', false);
        } else {
            // Enabling the master toggle switches every sub-option on, so the
            // detail sub-options must be set after it.
            this.setDisplayOption('showAircraftLabels', true);
            this.setDisplayOption('showAircraftId', true);
            const detail = level === 2;
            this.setDisplayOption('showAircraftType', detail);
            this.setDisplayOption('showAircraftSpeed', detail);
            this.setDisplayOption('showAircraftAltitude', detail);
        }

        const description = ['off', 'callsign only', 'full detail'][level];
        this.sendEcho(`Aircraft labels: ${description}`, 'success');

        return { handled: true, sendToServer: false };
    }

    /**
     * Current LABEL detail level derived from the display options:
     * 0 = labels off, 1 = callsign only, 2 = any further detail shown.
     */
    private currentLabelLevel(): number {
        const options = this.app.getStateManager().getDisplayOptions();
        if (!options.showAircraftLabels) return 0;
        return (options.showAircraftType || options.showAircraftSpeed || options.showAircraftAltitude) ? 2 : 1;
    }

    /**
     * Handle SWRAD command - BlueSky's classic radar-display switch:
     *   SWRAD APT/WPT/LABEL/SYM/TRAIL/POLY [level]
     * Each switch maps onto the matching WebATM display option. GEO/SAT
     * (coastlines/satellite background) have no equivalent here because the
     * basemap is a fixed part of the MapLibre style.
     */
    private handleSwradCommand(args: string): CommandResult {
        const parts = args.trim().split(/\s+/).filter(p => p.length > 0);
        const usage = 'Usage: SWRAD APT/WPT/LABEL/SYM/TRAIL/POLY [level]';
        if (parts.length === 0) {
            this.sendEcho(usage, 'warning');
            return { handled: true, sendToServer: false };
        }

        const sw = parts[0].toUpperCase();
        const rawArg = parts[1];
        const numArg = rawArg !== undefined ? parseInt(rawArg, 10) : undefined;
        if (rawArg !== undefined && (numArg === undefined || isNaN(numArg))) {
            this.sendEcho(`Invalid level for SWRAD ${sw}: ${rawArg}`, 'warning');
            return { handled: true, sendToServer: false };
        }
        // Numeric level: 0 hides, anything above shows (BlueSky's higher
        // levels add detail the web renderer does not distinguish)
        const flag = numArg === undefined ? undefined : numArg > 0;

        switch (sw) {
            case 'APT':
                return this.applySwradToggle('showAirports', 'Airports', flag);
            case 'WPT':
            case 'VOR':
                return this.applySwradToggle('showWaypoints', 'Waypoints', flag);
            case 'POLY':
                return this.applySwradToggle('showShapes', 'Shapes', flag);
            case 'TRAIL':
            case 'TRAILS':
                return this.applySwradToggle('showAircraftTrails', 'Aircraft trails', flag);
            case 'LABEL':
                return this.handleLabelCommand(rawArg ?? '');
            case 'SYM':
                return this.handleSymSwitch(numArg);
            case 'GEO':
            case 'SAT':
            case 'GRID':
            case 'ADSBCOVERAGE':
                this.sendEcho(`SWRAD ${sw} is not applicable in WebATM - the map background is part of the basemap style (see Map Controls)`, 'info');
                return { handled: true, sendToServer: false };
            default:
                this.sendEcho(`Unknown SWRAD switch: ${sw}. ${usage}`, 'warning');
                return { handled: true, sendToServer: false };
        }
    }

    /** Set or toggle one display option for SWRAD and echo the result. */
    private applySwradToggle(stateKey: keyof DisplayOptions, label: string, flag?: boolean): CommandResult {
        const applied = this.setDisplayOption(stateKey, flag);
        if (applied !== null) {
            this.sendEcho(`${label} ${applied ? 'shown' : 'hidden'}`, 'success');
        }
        return { handled: true, sendToServer: false };
    }

    /**
     * SWRAD SYM mirrors BlueSky's symbol level: 0 = no aircraft, 1 = aircraft
     * only, 2 = aircraft + protected zones. Without a level it cycles the way
     * BlueSky's GUI does.
     */
    private handleSymSwitch(numArg?: number): CommandResult {
        let level = numArg;
        if (level === undefined) {
            const options = this.app.getStateManager().getDisplayOptions();
            level = options.showProtectedZones ? 0 : (options.showAircraft ? 2 : 1);
        }

        this.setDisplayOption('showAircraft', level > 0);
        this.setDisplayOption('showProtectedZones', level > 1);
        this.sendEcho(`Aircraft symbols ${level > 0 ? 'shown' : 'hidden'}, protected zones ${level > 1 ? 'shown' : 'hidden'}`, 'success');

        return { handled: true, sendToServer: false };
    }

    /**
     * Parse an optional ON/OFF-style toggle argument.
     * Returns true/false for a recognized value, undefined for an empty
     * argument (meaning: toggle), and null for an unparseable one.
     */
    private parseToggleFlag(arg: string): boolean | undefined | null {
        if (!arg) return undefined;
        const upper = arg.toUpperCase();
        if (upper === 'ON' || upper === 'TRUE' || upper === 'YES') return true;
        if (upper === 'OFF' || upper === 'FALSE' || upper === 'NO') return false;
        const num = Number(arg);
        if (!isNaN(num)) return num > 0;
        return null;
    }

    /**
     * Set (or toggle, when value is undefined) a boolean display option via
     * the DisplayOptionsPanel, so the panel checkbox, localStorage, and
     * StateManager all stay in sync. Echoes an error when the option cannot
     * be applied (e.g. panel not wired up yet).
     */
    private setDisplayOption(stateKey: keyof DisplayOptions, value?: boolean): boolean | null {
        const applied = this.app.getDisplayOptionsPanel().setBooleanOption(stateKey, value);
        if (applied === null) {
            this.sendEcho('Display options are not available yet', 'error');
        }
        return applied;
    }

    /**
     * Handle MCRE command - add bounding box from current map view
     * Usage: MCRE [number] [ac_type]
     */
    private handleMcreCommand(args: string): CommandResult {
        const mapDisplay = this.requireMapInitialized();
        if (!mapDisplay) {
            return { handled: true, sendToServer: false };
        }

        // Get current map bounds [west, south, east, north]
        const bounds = mapDisplay.getCurrentBounds();
        if (!bounds || bounds.length !== 4) {
            this.sendEcho('Unable to get map bounds', 'error');
            return { handled: true, sendToServer: false };
        }

        const [west, south, east, north] = bounds;

        // Construct INSIDE command: INSIDE lat1 lon1 lat2 lon2 MCRE args
        // Using the bounding box coordinates in the format BlueSky expects
        const insideCommand = `INSIDE ${south.toFixed(14)} ${west.toFixed(14)} ${north.toFixed(14)} ${east.toFixed(14)} MCRE ${args}`.trim();

        this.sendEcho('MCRE command sent with map bounds', 'info');

        return {
            handled: true,
            sendToServer: true,
            modifiedCommand: insideCommand
        };
    }

    /**
     * Handle QUIT command - disconnect this client's session from BlueSky.
     *
     * BlueSky's real QUIT (see bluesky/network/server.py) is a *server-wide
     * shutdown*: it stops the headless server's loop and terminates every node
     * child process — there is no per-node quit. WebATM deliberately does NOT
     * forward QUIT to BlueSky:
     *   - The standalone build connects to a shared remote server, so forwarding
     *     QUIT would tear it down for every other user.
     *   - The integrated build bundles its own server, but its lifecycle is
     *     owned by the explicit Start / Stop / Restart / Kill controls — use
     *     those to actually shut it down.
     *
     * Instead, QUIT ends *this* client's BlueSky session: it disconnects
     * WebATM's proxy from BlueSky (via /api/server/disconnect) and immediately
     * reflects that in the shared connection status the header reads. Crucially
     * it does NOT drop the browser↔WebATM socket (the previous behavior), so the
     * page stays live and no manual refresh is needed to recover, and it leaves
     * the BlueSky server itself running and untouched.
     */
    private handleQuitCommand(): CommandResult {
        // Disconnect the proxy from BlueSky server-side. Fire-and-forget: the UI
        // updates immediately from the explicit user intent below, and the page
        // stays usable regardless of this request's outcome.
        void fetch('/api/server/disconnect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }).catch((err) => logger.error('CommandHandler', 'QUIT disconnect failed', err));

        // Reflect the explicit disconnect immediately in the single source of
        // truth the header — and, in the integrated build, the server-control
        // status — both read, so the indicators agree without waiting on the
        // data-flow timeout.
        connectionStatus.setBlueSkyConnected(false);

        this.sendEcho('Disconnected from BlueSky server (the server itself is left running)', 'info');

        return { handled: true, sendToServer: false };
    }

    /**
     * Handle commands that are recognized but not yet implemented
     */
    private handleNotImplemented(cmd: string): CommandResult {
        this.sendEcho(`${cmd} command not yet implemented`, 'warning');
        return { handled: true, sendToServer: false };
    }

    /**
     * Send a message to the echo panel with 'webatm' as the source
     */
    private sendEcho(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
        echoManager.addMessage(message, type, 'webatm');
    }

    /**
     * Returns the initialized MapDisplay, or null after emitting a
     * "Map not initialized" echo. Every caller that needs a ready map
     * uses this guard so the same error message is emitted everywhere.
     */
    private requireMapInitialized(): MapDisplay | null {
        const mapDisplay = this.app.getMapDisplay();
        if (!mapDisplay || !mapDisplay.isInitialized()) {
            this.sendEcho('Map not initialized', 'error');
            return null;
        }
        return mapDisplay;
    }

    /**
     * Emit a non-blocking console warning when the aircraft type argument of
     * a CRE/MCRE command is not part of the openap library. Matches the
     * message shown by AircraftCreationManager.updateAircraftTypeWarning().
     *
     * CRE  acid  type  lat lon hdg alt spd  -> type is parts[2]
     * MCRE count type  alt spd dest          -> type is parts[2]
     */
    private warnIfUnknownAircraftType(parts: string[]): void {
        if (parts.length < 3) return;
        const type = parts[2];
        if (!type) return;
        if (!isOpenapAircraftType(type)) {
            this.sendEcho(
                `openap library does not include "${type.toUpperCase()}"`,
                'warning'
            );
        }
    }

    /**
     * Parse latitude/longitude coordinates from string
     * Supports formats: "lat,lon" or "lat lon"
     */
    private parseLatLonCoordinates(input: string): { lat: number; lon: number } | null {
        // Try comma-separated first
        let parts = input.split(',').map(s => s.trim());

        // If no comma, try space-separated
        if (parts.length !== 2) {
            parts = input.split(/\s+/).filter(s => s.length > 0);
        }

        if (parts.length !== 2) {
            return null;
        }

        const lat = parseFloat(parts[0]);
        const lon = parseFloat(parts[1]);

        if (isNaN(lat) || isNaN(lon)) {
            return null;
        }

        // Validate ranges
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
            return null;
        }

        return { lat, lon };
    }
}
