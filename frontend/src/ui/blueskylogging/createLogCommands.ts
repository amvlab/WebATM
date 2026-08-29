/**
 * Pure data and command composition for the Create Log dialog: the preset
 * variable catalog, spec validation, and the BlueSky console commands that
 * realize a spec. Kept free of DOM so it is directly unit-testable.
 */

/**
 * A preset variable offered as a checkbox in the Create Log dialog.
 * `name` is the dotted BlueSky variable-explorer name sent to the server
 * (`LOGNAME ADD <name>`); `desc` is the human-readable label shown next to it.
 */
export interface LogVariablePreset {
    name: string;
    desc: string;
    checked?: boolean;
}

/**
 * Per-aircraft (traf) variables from BlueSky's variable explorer that are
 * useful in a data log. Names and units match bluesky/traffic/traffic.py.
 */
export const LOG_VARIABLE_PRESETS: readonly LogVariablePreset[] = [
    { name: 'traf.id', desc: 'callsign', checked: true },
    { name: 'traf.type', desc: 'aircraft type' },
    { name: 'traf.lat', desc: 'latitude [deg]', checked: true },
    { name: 'traf.lon', desc: 'longitude [deg]', checked: true },
    { name: 'traf.alt', desc: 'altitude [m]', checked: true },
    { name: 'traf.hdg', desc: 'heading [deg]' },
    { name: 'traf.trk', desc: 'track angle [deg]' },
    { name: 'traf.tas', desc: 'true airspeed [m/s]' },
    { name: 'traf.cas', desc: 'calibrated airspeed [m/s]' },
    { name: 'traf.gs', desc: 'ground speed [m/s]' },
    { name: 'traf.M', desc: 'Mach number' },
    { name: 'traf.vs', desc: 'vertical speed [m/s]' },
    { name: 'traf.distflown', desc: 'distance flown [m]' },
    { name: 'traf.selalt', desc: 'selected altitude [m]' },
    { name: 'traf.selspd', desc: 'selected speed [m/s]' },
];

/** Syntax for a single variable-explorer name, e.g. traf.perf.mass, lat[0] */
export const LOG_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*(\[\w+\])?$/;

/** Everything needed to create one BlueSky data logger. */
export interface CreateLogSpec {
    name: string;
    dt: number;
    header: string;
    variables: string[];
    startNow: boolean;
}

/**
 * Validate a CreateLogSpec. Returns an error message, or null when valid.
 */
export function validateLogSpec(spec: CreateLogSpec): string | null {
    if (!spec.name) {
        return 'Log name is required';
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(spec.name)) {
        return 'Log name must start with a letter and contain only letters, digits and underscores';
    }
    if (!Number.isFinite(spec.dt) || spec.dt <= 0) {
        return 'Update interval must be a positive number of seconds';
    }
    if (spec.variables.length === 0) {
        return 'Select at least one variable to log';
    }
    const badVar = spec.variables.find(v => !LOG_VARIABLE_NAME_PATTERN.test(v));
    if (badVar) {
        return `Invalid variable name: ${badVar}`;
    }
    return null;
}

/**
 * Compose the BlueSky console commands that create (and optionally start) the
 * logger described by `spec`:
 *   CRELOG NAME,dt[,header]   -> creates a periodic logger + a NAME command
 *   NAME ADD var1,var2,...    -> selects the variables to record
 *   NAME ON                   -> opens the log file and starts recording
 * Variable names are passed as-is: BlueSky's stack keeps the case of `word`
 * arguments, and the variable explorer is case-sensitive (traf.lat, traf.M).
 */
export function buildCreateLogCommands(spec: CreateLogSpec): string[] {
    const name = spec.name.toUpperCase();
    const commands: string[] = [];

    let crelog = `CRELOG ${name},${spec.dt}`;
    if (spec.header) {
        crelog += `,${spec.header}`;
    }
    commands.push(crelog);
    commands.push(`${name} ADD ${spec.variables.join(',')}`);
    if (spec.startNow) {
        commands.push(`${name} ON`);
    }
    return commands;
}
