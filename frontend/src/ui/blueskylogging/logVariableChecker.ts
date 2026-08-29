/**
 * Availability checking for BlueSky variable-explorer names (e.g.
 * `traf.perf.mass`), used by the Create Log dialog to validate custom
 * variables against the *running* simulation.
 *
 * There is no request/response API for this: the check works by sending the
 * console command `LSVAR <name>` and watching the echo stream for BlueSky's
 * reply (bluesky/core/varexplorer.py lsvar):
 *   - found:     an info block starting "Variable:   <last name component>"
 *   - not found: "Variable <name> not found"
 * Echo messages surface client-side as the `echoMessageAdded` document event
 * (dispatched by EchoManager for every message, including BlueSky replies).
 */
import { logger } from '../../utils/Logger';

export type VariableCheckResult = 'found' | 'not-found' | 'unknown';

export interface VariableCheckerDeps {
    /** Sends a console command to BlueSky (usually window.app.sendCommand). */
    sendCommand: (command: string) => unknown;
    /** Whether a BlueSky server is connected; when false the check is skipped. */
    isConnected: () => boolean;
    /** How long to wait for BlueSky's echo reply (default 2500 ms). */
    timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2500;

// The "found" reply names only the LAST component of the variable
// ("Variable:   mass" for traf.perf.mass), so two concurrent LSVAR
// round-trips could claim each other's reply. Serializing every round-trip
// (checks AND attribute discoveries) through this one queue keeps each reply
// attributable to exactly one pending LSVAR.
let queue: Promise<unknown> = Promise.resolve();

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface LsvarReply {
    status: 'found' | 'not-found' | 'timeout';
    /** Full reply text; present only when status is 'found'. */
    text?: string;
}

/**
 * One LSVAR round-trip: sends `LSVAR <name>` and resolves from the echoed
 * reply, carrying the full reply text on a hit so callers can parse more
 * out of it (e.g. the Attributes: line).
 */
function lsvarOne(name: string, deps: VariableCheckerDeps): Promise<LsvarReply> {
    return new Promise<LsvarReply>((resolve) => {
        // The last dotted component, without a trailing [index]
        const lastComponent = name.split('.').pop()!.replace(/\[\w+\]$/, '');
        const foundPattern = new RegExp(`(^|\\n)\\s*Variable:\\s+${escapeRegExp(lastComponent)}\\b`);
        const notFoundPattern = new RegExp(`Variable\\s+${escapeRegExp(name)}\\s+not found`, 'i');

        let timer: ReturnType<typeof setTimeout> | null = null;
        const onEcho = (e: DocumentEventMap['echoMessageAdded']): void => {
            const text = e.detail?.message ?? '';
            if (notFoundPattern.test(text)) {
                finish({ status: 'not-found' });
            } else if (foundPattern.test(text)) {
                finish({ status: 'found', text });
            }
        };
        const finish = (reply: LsvarReply): void => {
            if (timer) clearTimeout(timer);
            document.removeEventListener('echoMessageAdded', onEcho);
            logger.debug('logVariableChecker', `LSVAR ${name}: ${reply.status}`);
            resolve(reply);
        };

        document.addEventListener('echoMessageAdded', onEcho);
        timer = setTimeout(() => finish({ status: 'timeout' }), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        deps.sendCommand(`LSVAR ${name}`);
    });
}

async function checkOne(name: string, deps: VariableCheckerDeps): Promise<VariableCheckResult> {
    if (!deps.isConnected()) {
        return 'unknown';
    }
    const reply = await lsvarOne(name, deps);
    if (reply.status === 'timeout') return 'unknown';
    return reply.status;
}

/**
 * Check whether `name` exists in the running simulation's variable explorer.
 * Returns 'unknown' when no server is connected or no reply arrives in time
 * (callers should treat 'unknown' as "unverified", not as missing).
 */
export function checkLogVariable(name: string, deps: VariableCheckerDeps): Promise<VariableCheckResult> {
    const result = queue.then(() => checkOne(name, deps));
    // The queue must survive a rejected check; results themselves never reject.
    queue = result.catch(() => undefined);
    return result;
}

/** Check several variables (serialized); resolves to a name → result map. */
export async function checkLogVariables(
    names: readonly string[],
    deps: VariableCheckerDeps
): Promise<Map<string, VariableCheckResult>> {
    const results = new Map<string, VariableCheckResult>();
    for (const name of names) {
        results.set(name, await checkLogVariable(name, deps));
    }
    return results;
}

/**
 * Discover the attribute names under a variable-explorer object (e.g. 'traf',
 * 'traf.perf') by parsing the `Attributes:` line of its LSVAR reply.
 * Resolves to the attribute names (WITHOUT the parent prefix), [] when the
 * variable exists but has no listed attributes (a leaf), and null when it
 * does not exist, no server is connected, or no reply arrives in time.
 * Serialized on the same queue as availability checks so replies never
 * cross-match.
 */
export function discoverVariableAttributes(
    parent: string,
    deps: VariableCheckerDeps
): Promise<string[] | null> {
    const result = queue.then(async (): Promise<string[] | null> => {
        if (!deps.isConnected()) return null;
        const reply = await lsvarOne(parent, deps);
        if (reply.status !== 'found' || !reply.text) return null;
        const match = reply.text.match(/(^|\n)\s*Attributes:\s*(.+)/);
        if (!match) return [];
        return match[2].split(',').map(s => s.trim()).filter(s => s.length > 0);
    });
    queue = result.catch(() => undefined);
    return result;
}
