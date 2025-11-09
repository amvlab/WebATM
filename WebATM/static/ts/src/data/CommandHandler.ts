import type { App } from '../core/App';
import { echoManager } from '../ui/EchoManager';

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

    constructor(app: App) {
        this.app = app;
    }

    /**
     * Get all commands handled by this CommandHandler
     * This is the single source of truth for local/preprocessed commands
     */
    public getAllHandledCommands(): string[] {
        return [...this.LOCAL_COMMANDS, ...this.PREPROCESSED_COMMANDS];
    }

    /**
     * Get only the local commands (client-side only)
     */
    public getLocalCommands(): string[] {
        return [...this.LOCAL_COMMANDS];
    }

    /**
     * Get only the preprocessed commands
     */
    public getPreprocessedCommands(): string[] {
        return [...this.PREPROCESSED_COMMANDS];
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
        const cmd = parts[0].toUpperCase();
        const args = parts.slice(1).join(' ');

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
            case 'LABEL':
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
     * Handle PAN command - pan map to coordinates or aircraft
     * Usage: PAN <lat>,<lon> or PAN <lat> <lon> or PAN <aircraft_id>
     */
    private handlePanCommand(args: string): CommandResult {
        if (!args || args.trim().length === 0) {
            this.sendEcho('PAN command requires coordinates (e.g., PAN 52.3,4.8) or aircraft ID (e.g., PAN AF265)', 'warning');
            return {
                handled: true,
                sendToServer: false
            };
        }

        const mapDisplay = this.app.getMapDisplay();
        if (!mapDisplay || !mapDisplay.isInitialized()) {
            this.sendEcho('Map not initialized', 'error');
            return {
                handled: true,
                sendToServer: false
            };
        }

        // Try to parse as coordinates first (format: "lat,lon" or "lat lon")
        const coords = this.parseLatLonCoordinates(args);
        if (coords) {
            // Pan to coordinates
            mapDisplay.panTo(coords.lat, coords.lon);
            this.sendEcho(`Panned to ${coords.lat.toFixed(3)}, ${coords.lon.toFixed(3)}`, 'success');
            return {
                handled: true,
                sendToServer: false
            };
        }

        // Try as aircraft ID
        const stateManager = this.app.getStateManager();
        const aircraftData = stateManager.getState().aircraftData;

        if (!aircraftData || !aircraftData.id || aircraftData.id.length === 0) {
            this.sendEcho('No aircraft data available', 'warning');
            return {
                handled: true,
                sendToServer: false
            };
        }

        // Find aircraft (case-insensitive)
        const upperArgs = args.toUpperCase();
        const index = aircraftData.id.findIndex(id => id.toUpperCase() === upperArgs);

        if (index === -1) {
            this.sendEcho(`Aircraft ${args} not found`, 'warning');
            return {
                handled: true,
                sendToServer: false
            };
        }

        const lat = aircraftData.lat[index];
        const lon = aircraftData.lon[index];

        mapDisplay.panTo(lat, lon);
        this.sendEcho(`Panned to aircraft ${aircraftData.id[index]}`, 'success');

        return {
            handled: true,
            sendToServer: false
        };
    }

    /**
     * Handle ZOOM command - set specific zoom level
     * Usage: ZOOM <level> or ZOOM IN or ZOOM OUT
     */
    private handleZoomCommand(args: string): CommandResult {
        if (!args || args.trim().length === 0) {
            this.sendEcho('ZOOM command requires a level (e.g., ZOOM 8) or IN/OUT', 'warning');
            return {
                handled: true,
                sendToServer: false
            };
        }

        const mapDisplay = this.app.getMapDisplay();
        if (!mapDisplay || !mapDisplay.isInitialized()) {
            this.sendEcho('Map not initialized', 'error');
            return {
                handled: true,
                sendToServer: false
            };
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
            return {
                handled: true,
                sendToServer: false
            };
        }

        mapDisplay.setZoom(level);
        this.sendEcho(`Zoom set to ${level.toFixed(1)}`, 'success');

        return {
            handled: true,
            sendToServer: false
        };
    }

    /**
     * Handle ZOOMIN command - zoom in one level
     */
    private handleZoomInCommand(): CommandResult {
        const mapDisplay = this.app.getMapDisplay();
        if (!mapDisplay || !mapDisplay.isInitialized()) {
            this.sendEcho('Map not initialized', 'error');
            return {
                handled: true,
                sendToServer: false
            };
        }

        mapDisplay.zoomIn();
        this.sendEcho('Zoomed in', 'success');

        return {
            handled: true,
            sendToServer: false
        };
    }

    /**
     * Handle ZOOMOUT command - zoom out one level
     */
    private handleZoomOutCommand(): CommandResult {
        const mapDisplay = this.app.getMapDisplay();
        if (!mapDisplay || !mapDisplay.isInitialized()) {
            this.sendEcho('Map not initialized', 'error');
            return {
                handled: true,
                sendToServer: false
            };
        }

        mapDisplay.zoomOut();
        this.sendEcho('Zoomed out', 'success');

        return {
            handled: true,
            sendToServer: false
        };
    }

    /**
     * Handle MCRE command - add bounding box from current map view
     * Usage: MCRE [number] [ac_type]
     */
    private handleMcreCommand(args: string): CommandResult {
        const mapDisplay = this.app.getMapDisplay();
        if (!mapDisplay || !mapDisplay.isInitialized()) {
            this.sendEcho('Map not initialized', 'error');
            return {
                handled: true,
                sendToServer: false
            };
        }

        // Get current map bounds [west, south, east, north]
        const bounds = mapDisplay.getCurrentBounds();
        if (!bounds || bounds.length !== 4) {
            this.sendEcho('Unable to get map bounds', 'error');
            return {
                handled: true,
                sendToServer: false
            };
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
     * Handle QUIT command - disconnect from server
     */
    private handleQuitCommand(): CommandResult {
        // Disconnect from server
        const socketManager = this.app.getSocketManager();
        socketManager.disconnect();

        this.sendEcho('Disconnected from server', 'info');

        return {
            handled: true,
            sendToServer: false
        };
    }

    /**
     * Handle commands that are recognized but not yet implemented
     */
    private handleNotImplemented(cmd: string): CommandResult {
        this.sendEcho(`${cmd} command not yet implemented`, 'warning');
        return {
            handled: true,
            sendToServer: false
        };
    }

    /**
     * Send a message to the echo panel with 'webatm' as the source
     */
    private sendEcho(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
        echoManager.addMessage(message, type, 'webatm');
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
