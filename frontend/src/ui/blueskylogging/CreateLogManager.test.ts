// @vitest-environment happy-dom
/**
 * Create Log dialog: command composition for BlueSky's CRELOG logging
 * system, form validation, and the quick Start/Stop chips in the Output
 * Log tab.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    buildCreateLogCommands,
    validateLogSpec,
    LOG_VARIABLE_PRESETS,
    type CreateLogSpec,
} from './CreateLogManager';
// The availability checker performs an LSVAR echo round-trip against a live
// server; mock it so DOM tests control the verdicts directly (tests obtain
// the post-reset mock instance via boot(), not a static import).
vi.mock('./logVariableChecker', () => ({
    checkLogVariable: vi.fn(async () => 'unknown'),
    checkLogVariables: vi.fn(async () => new Map()),
    discoverVariableAttributes: vi.fn(async () => null),
}));

function makeSpec(overrides: Partial<CreateLogSpec> = {}): CreateLogSpec {
    return {
        name: 'MYLOG',
        dt: 1,
        header: '',
        variables: ['traf.id', 'traf.lat'],
        startNow: true,
        ...overrides,
    };
}

describe('buildCreateLogCommands', () => {
    it('composes CRELOG, ADD and ON commands', () => {
        expect(buildCreateLogCommands(makeSpec())).toEqual([
            'CRELOG MYLOG,1',
            'MYLOG ADD traf.id,traf.lat',
            'MYLOG ON',
        ]);
    });

    it('appends the header to CRELOG when given', () => {
        const commands = buildCreateLogCommands(makeSpec({ header: 'My experiment', dt: 0.5 }));
        expect(commands[0]).toBe('CRELOG MYLOG,0.5,My experiment');
    });

    it('omits ON when startNow is false', () => {
        const commands = buildCreateLogCommands(makeSpec({ startNow: false }));
        expect(commands).toHaveLength(2);
        expect(commands.some(c => c.endsWith(' ON'))).toBe(false);
    });

    it('uppercases the logger name but preserves variable case', () => {
        // BlueSky's variable explorer is case-sensitive (traf.M is Mach)
        const commands = buildCreateLogCommands(makeSpec({ name: 'mylog', variables: ['traf.M'] }));
        expect(commands[0]).toBe('CRELOG MYLOG,1');
        expect(commands[1]).toBe('MYLOG ADD traf.M');
    });
});

describe('validateLogSpec', () => {
    it('accepts a valid spec', () => {
        expect(validateLogSpec(makeSpec())).toBeNull();
    });

    it.each([
        ['empty name', makeSpec({ name: '' }), /name is required/i],
        ['name with spaces', makeSpec({ name: 'MY LOG' }), /letters, digits/i],
        ['name starting with a digit', makeSpec({ name: '1LOG' }), /start with a letter/i],
        ['non-positive dt', makeSpec({ dt: 0 }), /positive number/i],
        ['NaN dt', makeSpec({ dt: NaN }), /positive number/i],
        ['no variables', makeSpec({ variables: [] }), /at least one variable/i],
        ['malformed variable', makeSpec({ variables: ['traf.lat', 'bad var!'] }), /invalid variable/i],
    ])('rejects %s', (_label, spec, pattern) => {
        expect(validateLogSpec(spec)).toMatch(pattern);
    });

    it('accepts dotted and indexed variable names', () => {
        expect(validateLogSpec(makeSpec({ variables: ['traf.perf.mass', 'sim.simdt', 'lat[0]'] }))).toBeNull();
    });

    it('accepts every preset variable', () => {
        expect(validateLogSpec(makeSpec({ variables: LOG_VARIABLE_PRESETS.map(p => p.name) }))).toBeNull();
    });
});

// --- DOM behavior -----------------------------------------------------------

function buildDom(): void {
    document.body.innerHTML = `
        <button id="create-log-btn" style="display: none;">+ Create Log</button>
        <div id="log-quick-controls" style="display: none;"></div>
        <div id="create-log-modal" class="modal" style="display: none;">
            <button class="modal-close" id="create-log-modal-close">&times;</button>
            <input type="text" id="create-log-name-input">
            <input type="number" id="create-log-dt-input" value="1.0">
            <input type="text" id="create-log-header-input">
            <div id="create-log-var-grid"></div>
            <input type="text" id="create-log-custom-vars">
            <button id="create-log-add-var-btn">Add</button>
            <small id="create-log-custom-status" style="display: none;"></small>
            <input type="checkbox" id="create-log-start-checkbox" checked>
            <pre id="create-log-preview"></pre>
            <div id="create-log-error" style="display: none;"></div>
            <button id="create-log-submit-btn">Create Log</button>
            <button id="create-log-cancel-btn">Cancel</button>
        </div>
    `;
}

describe('CreateLogManager (DOM)', () => {
    // sendCommand mock behind window.app, reinstalled per test
    let sendCommand: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.resetModules(); // fresh singletons (modalManager, createLogManager)
        localStorage.clear();
        // The mocked checker fns survive resetModules with their call history
        // and configured results — reset them to the defaults per test.
        const checker = await import('./logVariableChecker');
        vi.mocked(checker.checkLogVariable).mockReset().mockResolvedValue('unknown');
        vi.mocked(checker.checkLogVariables).mockReset().mockResolvedValue(new Map());
        buildDom();
        sendCommand = vi.fn().mockResolvedValue(true);
        vi.stubGlobal('app', {
            sendCommand,
            getStateManager: () => ({ getState: () => ({ cmddict: { POS: 'Get info', CRE: 'Create' } }) }),
        });
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    // After vi.resetModules() the manager binds to a FRESH instance of the
    // mocked checker module, so tests must configure that instance (returned
    // here), not the one imported at the top of this file.
    async function boot() {
        const checker = await import('./logVariableChecker');
        const module = await import('./CreateLogManager');
        return { manager: module.createLogManager, checker };
    }

    function setValue(id: string, value: string): void {
        (document.getElementById(id) as HTMLInputElement).value = value;
    }

    it('renders the preset variable grid with defaults checked', async () => {
        await boot();
        const boxes = document.querySelectorAll<HTMLInputElement>('#create-log-var-grid input[data-varname]');
        expect(boxes.length).toBe(LOG_VARIABLE_PRESETS.length);
        const checked = Array.from(boxes).filter(b => b.checked).map(b => b.dataset.varname);
        expect(checked).toEqual(LOG_VARIABLE_PRESETS.filter(p => p.checked).map(p => p.name));
    });

    it('sends CRELOG/ADD/ON on submit and renders a running chip', async () => {
        const { manager } = await boot();
        manager.openDialog();
        setValue('create-log-name-input', 'flighttest');
        setValue('create-log-dt-input', '2');
        setValue('create-log-custom-vars', 'sim.simdt');
        (document.getElementById('create-log-submit-btn') as HTMLElement).click();

        await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(3));
        const sent = sendCommand.mock.calls.map(c => c[0] as string);
        expect(sent[0]).toBe('CRELOG FLIGHTTEST,2');
        expect(sent[1]).toMatch(/^FLIGHTTEST ADD traf\.id,traf\.lat,traf\.lon,traf\.alt,sim\.simdt$/);
        expect(sent[2]).toBe('FLIGHTTEST ON');

        // Quick-control chip appears, marked running
        const chip = document.querySelector('#log-quick-controls .log-chip');
        expect(chip).not.toBeNull();
        expect(chip!.classList.contains('running')).toBe(true);
        expect(chip!.textContent).toContain('FLIGHTTEST');

        // Modal closed after successful submit
        const modal = document.getElementById('create-log-modal') as HTMLElement;
        expect(modal.style.display).toBe('none');
    });

    it('shows a validation error and sends nothing for a bad name', async () => {
        const { manager } = await boot();
        manager.openDialog();
        setValue('create-log-name-input', '1BAD');
        (document.getElementById('create-log-submit-btn') as HTMLElement).click();

        const errorEl = document.getElementById('create-log-error') as HTMLElement;
        await vi.waitFor(() => expect(errorEl.style.display).not.toBe('none'));
        expect(errorEl.textContent).toMatch(/start with a letter/i);
        expect(sendCommand).not.toHaveBeenCalled();
    });

    it('blocks a name that collides with an existing BlueSky command', async () => {
        const { manager } = await boot();
        manager.openDialog();
        setValue('create-log-name-input', 'pos');
        (document.getElementById('create-log-submit-btn') as HTMLElement).click();

        const errorEl = document.getElementById('create-log-error') as HTMLElement;
        await vi.waitFor(() => expect(errorEl.textContent).toMatch(/already a BlueSky command/i));
        expect(sendCommand).not.toHaveBeenCalled();
    });

    it('toggles a tracked logger OFF and ON from its chip', async () => {
        const { manager } = await boot();
        manager.openDialog();
        setValue('create-log-name-input', 'MYLOG');
        (document.getElementById('create-log-submit-btn') as HTMLElement).click();
        await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(3));

        const toggle = () =>
            (document.querySelector('#log-quick-controls [data-action="toggle-log"]') as HTMLElement).click();

        toggle(); // running -> stopped
        await vi.waitFor(() => expect(sendCommand).toHaveBeenLastCalledWith('MYLOG OFF'));
        expect(document.querySelector('.log-chip')!.classList.contains('running')).toBe(false);

        toggle(); // stopped -> running
        await vi.waitFor(() => expect(sendCommand).toHaveBeenLastCalledWith('MYLOG ON'));
        expect(document.querySelector('.log-chip')!.classList.contains('running')).toBe(true);
    });

    it('marks all chips stopped on simulation-reset', async () => {
        const { manager } = await boot();
        manager.openDialog();
        setValue('create-log-name-input', 'MYLOG');
        (document.getElementById('create-log-submit-btn') as HTMLElement).click();
        await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(3));
        expect(document.querySelector('.log-chip')!.classList.contains('running')).toBe(true);

        document.dispatchEvent(new CustomEvent('simulation-reset'));
        expect(document.querySelector('.log-chip')!.classList.contains('running')).toBe(false);
        expect(manager.getTrackedLoggers().get('MYLOG')!.running).toBe(false);
    });

    it('re-creating a logger tracked this session is allowed despite cmddict', async () => {
        // Once created, the logger's name IS a stack command server-side; the
        // dialog must still allow re-submitting it (ADD/ON re-configure it).
        const { manager } = await boot();
        manager.openDialog();
        setValue('create-log-name-input', 'MYLOG');
        (document.getElementById('create-log-submit-btn') as HTMLElement).click();
        await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(3));

        vi.stubGlobal('app', {
            sendCommand,
            getStateManager: () => ({ getState: () => ({ cmddict: { MYLOG: 'logger cmd' } }) }),
        });

        manager.openDialog();
        setValue('create-log-name-input', 'MYLOG');
        (document.getElementById('create-log-submit-btn') as HTMLElement).click();
        await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(6));
    });

    // --- Custom variables: add / validate / cache / grey-out ---

    const gridBox = (name: string): HTMLInputElement | null =>
        document.querySelector<HTMLInputElement>(`#create-log-var-grid input[data-varname="${name}"]`);
    const statusEl = (): HTMLElement => document.getElementById('create-log-custom-status') as HTMLElement;

    it('adds a verified custom variable to the grid and persists it', async () => {
        const { manager, checker } = await boot();
        vi.mocked(checker.checkLogVariable).mockResolvedValue('found');
        manager.openDialog();

        setValue('create-log-custom-vars', 'traf.perf.mass');
        (document.getElementById('create-log-add-var-btn') as HTMLElement).click();

        await vi.waitFor(() => expect(gridBox('traf.perf.mass')).not.toBeNull());
        expect(checker.checkLogVariable).toHaveBeenCalledWith('traf.perf.mass', expect.anything());
        expect(gridBox('traf.perf.mass')!.checked).toBe(true);
        expect(gridBox('traf.perf.mass')!.disabled).toBe(false);
        expect(statusEl().textContent).toMatch(/added \(verified/);
        expect((document.getElementById('create-log-custom-vars') as HTMLInputElement).value).toBe('');
        expect(JSON.parse(localStorage.getItem('webatm-custom-log-variables')!)).toEqual(['traf.perf.mass']);
    });

    it('adds via the Enter key in the input', async () => {
        const { manager, checker } = await boot();
        vi.mocked(checker.checkLogVariable).mockResolvedValue('unknown');
        manager.openDialog();

        const input = document.getElementById('create-log-custom-vars') as HTMLInputElement;
        input.value = 'sim.simdt';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

        await vi.waitFor(() => expect(gridBox('sim.simdt')).not.toBeNull());
        // 'unknown' (no simulation reply) still adds, marked unverified
        expect(statusEl().textContent).toMatch(/could not verify/);
    });

    it('blocks adding a variable the simulation reports as not found', async () => {
        const { manager, checker } = await boot();
        vi.mocked(checker.checkLogVariable).mockResolvedValue('not-found');
        manager.openDialog();

        setValue('create-log-custom-vars', 'traf.nope');
        (document.getElementById('create-log-add-var-btn') as HTMLElement).click();

        await vi.waitFor(() => expect(statusEl().textContent).toMatch(/not found in the current simulation/));
        expect(gridBox('traf.nope')).toBeNull();
        expect(localStorage.getItem('webatm-custom-log-variables')).toBeNull();
    });

    it('greys out cached variables unavailable in the current simulation', async () => {
        localStorage.setItem('webatm-custom-log-variables', JSON.stringify(['traf.perf.mass', 'traf.oldvar']));
        const { manager, checker } = await boot();
        vi.mocked(checker.checkLogVariables).mockResolvedValue(new Map([
            ['traf.perf.mass', 'found'],
            ['traf.oldvar', 'not-found'],
        ]));
        manager.openDialog();

        await vi.waitFor(() => expect(gridBox('traf.oldvar')!.disabled).toBe(true));
        expect(gridBox('traf.oldvar')!.closest('.create-log-var-item')!.classList.contains('unavailable')).toBe(true);
        expect(gridBox('traf.perf.mass')!.disabled).toBe(false);
        expect(gridBox('traf.perf.mass')!.checked).toBe(true);

        // A greyed-out variable never reaches the ADD command
        setValue('create-log-name-input', 'MYLOG');
        (document.getElementById('create-log-submit-btn') as HTMLElement).click();
        await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(3));
        const addCommand = sendCommand.mock.calls[1][0] as string;
        expect(addCommand).toContain('traf.perf.mass');
        expect(addCommand).not.toContain('traf.oldvar');
    });

    it('forgets a cached custom variable via its remove button', async () => {
        localStorage.setItem('webatm-custom-log-variables', JSON.stringify(['traf.perf.mass']));
        const { manager } = await boot();
        manager.openDialog();
        await vi.waitFor(() => expect(gridBox('traf.perf.mass')).not.toBeNull());

        (document.querySelector('[data-action="remove-var"]') as HTMLElement).click();
        expect(gridBox('traf.perf.mass')).toBeNull();
        expect(JSON.parse(localStorage.getItem('webatm-custom-log-variables')!)).toEqual([]);
    });

    it('ticks the existing entry instead of duplicating an already-listed variable', async () => {
        const { manager, checker } = await boot();
        manager.openDialog();

        const box = gridBox('traf.gs')!; // preset, unchecked by default
        expect(box.checked).toBe(false);
        setValue('create-log-custom-vars', 'traf.gs');
        (document.getElementById('create-log-add-var-btn') as HTMLElement).click();

        await vi.waitFor(() => expect(statusEl().textContent).toMatch(/already in the list/));
        expect(gridBox('traf.gs')!.checked).toBe(true);
        expect(checker.checkLogVariable).not.toHaveBeenCalled();
        expect(document.querySelectorAll('input[data-varname="traf.gs"]').length).toBe(1);
    });
});
