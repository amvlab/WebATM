// @vitest-environment happy-dom
/**
 * LSVAR-based availability checking for custom log variables: the checker
 * sends `LSVAR <name>` and resolves from BlueSky's echoed reply (surfaced as
 * the `echoMessageAdded` document event).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    checkLogVariable,
    checkLogVariables,
    discoverVariableAttributes,
    type VariableCheckerDeps,
} from './logVariableChecker';

function echo(message: string): void {
    document.dispatchEvent(new CustomEvent('echoMessageAdded', {
        detail: { message, type: 'info', timestamp: new Date() },
    }));
}

function makeDeps(overrides: Partial<VariableCheckerDeps> = {}): VariableCheckerDeps & { sendCommand: ReturnType<typeof vi.fn> } {
    return {
        sendCommand: vi.fn(),
        isConnected: () => true,
        timeoutMs: 200,
        ...overrides,
    } as VariableCheckerDeps & { sendCommand: ReturnType<typeof vi.fn> };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('checkLogVariable', () => {
    it('resolves "found" on BlueSky\'s variable info reply', async () => {
        const deps = makeDeps();
        const promise = checkLogVariable('traf.perf.mass', deps);
        // The check starts asynchronously (queued); wait for the LSVAR send
        await vi.waitFor(() => expect(deps.sendCommand).toHaveBeenCalledWith('LSVAR traf.perf.mass'));

        // The found reply names only the LAST component (varexplorer.lsvar)
        echo('\nVariable:   mass\nType:       ndarray\nParent:     traf.perf\n');
        await expect(promise).resolves.toBe('found');
    });

    it('resolves "not-found" on the not-found reply', async () => {
        const deps = makeDeps();
        const promise = checkLogVariable('traf.perf.nope', deps);
        await vi.waitFor(() => expect(deps.sendCommand).toHaveBeenCalled());
        echo('Variable traf.perf.nope not found');
        await expect(promise).resolves.toBe('not-found');
    });

    it('ignores unrelated echo traffic while waiting', async () => {
        const deps = makeDeps();
        const promise = checkLogVariable('traf.gs', deps);
        await vi.waitFor(() => expect(deps.sendCommand).toHaveBeenCalled());
        echo('Created periodic logger MYLOG');
        echo('Variable traf.qs not found'); // different name
        echo('\nVariable:   gs\nType:       ndarray\nParent:     traf');
        await expect(promise).resolves.toBe('found');
    });

    it('resolves "unknown" when no reply arrives before the timeout', async () => {
        await expect(checkLogVariable('traf.lat', makeDeps({ timeoutMs: 30 }))).resolves.toBe('unknown');
    });

    it('resolves "unknown" immediately when not connected, without sending', async () => {
        const deps = makeDeps({ isConnected: () => false });
        await expect(checkLogVariable('traf.lat', deps)).resolves.toBe('unknown');
        expect(deps.sendCommand).not.toHaveBeenCalled();
    });

    it('serializes concurrent checks so replies cannot cross-match', async () => {
        // Both variables end in the same last component ("mass"), so replies
        // are only attributable if the second LSVAR is sent after the first
        // check resolved.
        const deps = makeDeps();
        const first = checkLogVariable('traf.perf.mass', deps);
        const second = checkLogVariable('other.mass', deps);
        await vi.waitFor(() => expect(deps.sendCommand).toHaveBeenCalled());
        expect(deps.sendCommand).toHaveBeenCalledTimes(1);

        echo('\nVariable:   mass\nType:       ndarray\nParent:     traf.perf');
        await expect(first).resolves.toBe('found');
        await vi.waitFor(() => expect(deps.sendCommand).toHaveBeenCalledTimes(2));
        expect(deps.sendCommand).toHaveBeenLastCalledWith('LSVAR other.mass');

        echo('Variable other.mass not found');
        await expect(second).resolves.toBe('not-found');
    });
});

describe('discoverVariableAttributes', () => {
    it('parses the Attributes line of the LSVAR reply', async () => {
        const deps = makeDeps();
        const promise = discoverVariableAttributes('traf.perf', deps);
        await vi.waitFor(() => expect(deps.sendCommand).toHaveBeenCalledWith('LSVAR traf.perf'));

        echo('\nVariable:   perf\nType:       OpenAP\nParent:     traf\nAttributes: actype, mass, thrust\n');
        await expect(promise).resolves.toEqual(['actype', 'mass', 'thrust']);
    });

    it('resolves [] for a leaf variable without attributes', async () => {
        const deps = makeDeps();
        const promise = discoverVariableAttributes('traf.lat', deps);
        await vi.waitFor(() => expect(deps.sendCommand).toHaveBeenCalled());
        echo('\nVariable:   lat\nType:       ndarray (TrafficArray)\nSize:       3\nParent:     traf');
        await expect(promise).resolves.toEqual([]);
    });

    it('resolves null on not-found, timeout, and disconnected', async () => {
        const deps = makeDeps();
        const notFound = discoverVariableAttributes('traf.nope', deps);
        await vi.waitFor(() => expect(deps.sendCommand).toHaveBeenCalled());
        echo('Variable traf.nope not found');
        await expect(notFound).resolves.toBeNull();

        await expect(discoverVariableAttributes('traf', makeDeps({ timeoutMs: 30 }))).resolves.toBeNull();

        const offline = makeDeps({ isConnected: () => false });
        await expect(discoverVariableAttributes('traf', offline)).resolves.toBeNull();
        expect(offline.sendCommand).not.toHaveBeenCalled();
    });

    it('shares the serialization queue with availability checks', async () => {
        // A check for "perf" and a discovery of "traf.perf" both match a
        // reply naming "perf" - serialization keeps them attributable.
        const deps = makeDeps();
        const check = checkLogVariable('perf', deps);
        const discovery = discoverVariableAttributes('traf.perf', deps);
        await vi.waitFor(() => expect(deps.sendCommand).toHaveBeenCalled());
        expect(deps.sendCommand).toHaveBeenCalledTimes(1);

        echo('\nVariable:   perf\nType:       OpenAP\nParent:     traf\nAttributes: mass');
        await expect(check).resolves.toBe('found');
        await vi.waitFor(() => expect(deps.sendCommand).toHaveBeenCalledTimes(2));
        echo('\nVariable:   perf\nType:       OpenAP\nParent:     traf\nAttributes: mass');
        await expect(discovery).resolves.toEqual(['mass']);
    });
});

describe('checkLogVariables', () => {
    it('checks each name and returns a result map', async () => {
        const deps = makeDeps();
        const promise = checkLogVariables(['traf.gs', 'traf.nope'], deps);

        await vi.waitFor(() => expect(deps.sendCommand).toHaveBeenCalledWith('LSVAR traf.gs'));
        echo('\nVariable:   gs\nType:       ndarray\nParent:     traf');
        await vi.waitFor(() => expect(deps.sendCommand).toHaveBeenCalledWith('LSVAR traf.nope'));
        echo('Variable traf.nope not found');

        const results = await promise;
        expect(results.get('traf.gs')).toBe('found');
        expect(results.get('traf.nope')).toBe('not-found');
    });
});
