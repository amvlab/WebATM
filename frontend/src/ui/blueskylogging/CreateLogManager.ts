import { connectionStatus } from '../../core/ConnectionStatusService';
import { logger } from '../../utils/Logger';
import { onDOMReady, escapeHtml } from '../../utils/dom';
import { storage } from '../../utils/StorageManager';
import {
    buildCreateLogCommands,
    LOG_VARIABLE_NAME_PATTERN,
    LOG_VARIABLE_PRESETS,
    validateLogSpec,
    type CreateLogSpec,
} from './createLogCommands';
import { echoManager } from '../EchoManager';
import {
    checkLogVariable,
    checkLogVariables,
    type VariableCheckResult,
    type VariableCheckerDeps,
} from './logVariableChecker';
import { VariableSearchIndex, VariableSuggestDropdown } from './logVariableSearch';
import { modalManager } from '../ModalManager';

// Re-exported for existing importers/tests; the definitions live in
// createLogCommands.ts so the pure parts stay DOM-free.
export {
    buildCreateLogCommands,
    LOG_VARIABLE_PRESETS,
    validateLogSpec,
    type CreateLogSpec,
    type LogVariablePreset,
} from './createLogCommands';

/** A logger created through the dialog in this browser session. */
interface TrackedLogger {
    name: string;
    dt: number;
    running: boolean;
}

/**
 * Wires the "+ Create Log" button and dialog in the Output Log tab: composes
 * BlueSky CRELOG/ADD/ON commands from the form, and renders a quick
 * Start/Stop chip per logger created this session so a log can be toggled
 * without retyping console commands.
 */
export class CreateLogManager {
    private openBtn: HTMLElement | null = null;
    private submitBtn: HTMLElement | null = null;
    private cancelBtn: HTMLElement | null = null;
    private nameInput: HTMLInputElement | null = null;
    private dtInput: HTMLInputElement | null = null;
    private headerInput: HTMLInputElement | null = null;
    private customVarsInput: HTMLInputElement | null = null;
    private addVarBtn: HTMLButtonElement | null = null;
    private customStatusEl: HTMLElement | null = null;
    private startCheckbox: HTMLInputElement | null = null;
    private varGrid: HTMLElement | null = null;
    private previewEl: HTMLElement | null = null;
    private errorEl: HTMLElement | null = null;
    private quickControlsEl: HTMLElement | null = null;

    private loggers: Map<string, TrackedLogger> = new Map();
    // Custom variables added through the dialog, persisted in localStorage so
    // frequently-used ("classic") ones survive across sessions, plus their
    // last known availability in the connected simulation.
    private customVars: string[] = [];
    private customAvailability: Map<string, VariableCheckResult> = new Map();
    private searchIndex: VariableSearchIndex | null = null;
    private suggestDropdown: VariableSuggestDropdown | null = null;
    private isInitialized = false;

    // Delay before refreshing the output file browser after a logger starts,
    // so BlueSky has created the file by the time the listing is fetched.
    private static readonly REFRESH_DELAY_MS = 1000;
    private static readonly MODAL_ID = 'create-log-modal';
    private static readonly STORAGE_KEY = 'custom-log-variables';

    constructor() {
        onDOMReady(() => this.initializeElements());
    }

    private initializeElements(): void {
        if (this.isInitialized) return;

        this.openBtn = document.getElementById('create-log-btn');
        this.submitBtn = document.getElementById('create-log-submit-btn');
        this.cancelBtn = document.getElementById('create-log-cancel-btn');
        this.nameInput = document.getElementById('create-log-name-input') as HTMLInputElement | null;
        this.dtInput = document.getElementById('create-log-dt-input') as HTMLInputElement | null;
        this.headerInput = document.getElementById('create-log-header-input') as HTMLInputElement | null;
        this.customVarsInput = document.getElementById('create-log-custom-vars') as HTMLInputElement | null;
        this.addVarBtn = document.getElementById('create-log-add-var-btn') as HTMLButtonElement | null;
        this.customStatusEl = document.getElementById('create-log-custom-status');
        this.startCheckbox = document.getElementById('create-log-start-checkbox') as HTMLInputElement | null;
        this.varGrid = document.getElementById('create-log-var-grid');
        this.previewEl = document.getElementById('create-log-preview');
        this.errorEl = document.getElementById('create-log-error');
        this.quickControlsEl = document.getElementById('log-quick-controls');

        this.customVars = storage.get<string[]>(CreateLogManager.STORAGE_KEY, []) ?? [];

        // Live variable search: index discovered from the sim via LSVAR,
        // suggestions rendered under the custom-variable input.
        const suggestList = document.getElementById('create-log-suggest-list');
        this.searchIndex = new VariableSearchIndex(
            () => this.checkerDeps(),
            () => this.suggestDropdown?.refresh());
        if (this.customVarsInput && suggestList) {
            this.suggestDropdown = new VariableSuggestDropdown(
                this.customVarsInput, suggestList, this.searchIndex,
                (name) => {
                    if (this.customVarsInput) this.customVarsInput.value = name;
                    void this.addCustomVariable();
                });
        }

        this.renderVariableGrid();
        this.setupEventListeners();
        this.isInitialized = true;
        logger.debug('CreateLogManager', 'Initialized');
    }

    private setupEventListeners(): void {
        this.openBtn?.addEventListener('click', () => this.openDialog());
        this.submitBtn?.addEventListener('click', () => void this.submit());
        this.cancelBtn?.addEventListener('click', () => modalManager.close(CreateLogManager.MODAL_ID));

        // Custom variables: Add button, or Enter in the input
        this.addVarBtn?.addEventListener('click', () => void this.addCustomVariable());
        this.customVarsInput?.addEventListener('keydown', (e) => {
            // The suggestion dropdown consumes Enter (preventDefault) when it
            // picks a highlighted item, so only add the raw text otherwise.
            if (e.key === 'Enter' && !e.defaultPrevented) {
                e.preventDefault();
                void this.addCustomVariable();
            }
        });

        // Remove (forget) a saved custom variable from its ✕ button. The
        // button lives inside the item's <label>, so stop the click from
        // also toggling the checkbox.
        this.varGrid?.addEventListener('click', (e) => {
            const target = (e.target as HTMLElement)?.closest('[data-action="remove-var"]') as HTMLElement | null;
            if (!target) return;
            e.preventDefault();
            this.removeCustomVariable(target.dataset.varname || '');
        });

        // Live command preview follows every form change
        const modal = document.getElementById(CreateLogManager.MODAL_ID);
        modal?.addEventListener('input', () => this.updatePreview());
        modal?.addEventListener('change', () => this.updatePreview());

        // Quick-control chips (event delegation, like OutputFileBrowser)
        this.quickControlsEl?.addEventListener('click', (e) => {
            const target = (e.target as HTMLElement)?.closest('[data-action]') as HTMLElement | null;
            if (!target) return;
            const name = target.dataset.log || '';
            const action = target.dataset.action;
            if (action === 'toggle-log') {
                void this.toggleLogger(name);
            } else if (action === 'dismiss-log') {
                this.loggers.delete(name);
                this.renderQuickControls();
            }
        });

        // A simulation RESET closes every log file server-side
        // (bluesky/tools/datalog.py reset()), so flip the chips to stopped.
        document.addEventListener('simulation-reset', () => {
            let anyRunning = false;
            this.loggers.forEach(l => {
                if (l.running) anyRunning = true;
                l.running = false;
            });
            if (anyRunning) {
                this.renderQuickControls();
                echoManager.addMessage('Simulation reset - data logs closed', 'info', 'webatm');
            }
        });
    }

    /**
     * Render the preset variables plus the saved custom ones. Custom items
     * carry a ✕ to forget them and are greyed out (checkbox disabled) when
     * their last availability check against the connected simulation failed.
     * Existing checkbox states survive a re-render (availability updates
     * arrive async while the dialog is open).
     */
    private renderVariableGrid(): void {
        if (!this.varGrid) return;

        const previous = new Map<string, boolean>();
        this.varGrid.querySelectorAll<HTMLInputElement>('input[data-varname]').forEach(cb => {
            if (cb.dataset.varname) previous.set(cb.dataset.varname, cb.checked);
        });
        const wasChecked = (name: string, fallback: boolean): boolean =>
            previous.get(name) ?? fallback;

        const presetItems = LOG_VARIABLE_PRESETS.map(preset => `
            <label class="create-log-var-item" title="${escapeHtml(preset.name)} - ${escapeHtml(preset.desc)}">
                <input type="checkbox" data-varname="${escapeHtml(preset.name)}" ${wasChecked(preset.name, preset.checked ?? false) ? 'checked' : ''}>
                <span class="create-log-var-name">${escapeHtml(preset.name.replace(/^traf\./, ''))}</span>
                <span class="create-log-var-desc">${escapeHtml(preset.desc)}</span>
            </label>`);

        const customItems = this.customVars.map(name => {
            const availability = this.customAvailability.get(name);
            const unavailable = availability === 'not-found';
            const title = unavailable
                ? `${name} - not found in the current BlueSky simulation`
                : `${name} - custom variable${availability === 'found' ? '' : ' (not verified)'}`;
            return `
            <label class="create-log-var-item ${unavailable ? 'unavailable' : ''}" title="${escapeHtml(title)}">
                <input type="checkbox" data-varname="${escapeHtml(name)}" ${unavailable ? 'disabled' : (wasChecked(name, true) ? 'checked' : '')}>
                <span class="create-log-var-name">${escapeHtml(name)}</span>
                <button class="create-log-var-remove" data-action="remove-var" data-varname="${escapeHtml(name)}" title="Forget this custom variable">&times;</button>
            </label>`;
        });

        this.varGrid.innerHTML = [...presetItems, ...customItems].join('');
    }

    public openDialog(): void {
        // The modal auto-registers on DOM ready, but make sure (cheap and
        // idempotent) so open() cannot fail on ordering.
        if (!modalManager.getRegisteredModals().includes(CreateLogManager.MODAL_ID)) {
            modalManager.registerModal(CreateLogManager.MODAL_ID);
        }
        this.showError(null);
        this.setCustomStatus(null);
        this.updatePreview();
        modalManager.open(CreateLogManager.MODAL_ID);
        this.nameInput?.focus();
        this.searchIndex?.seed();
        void this.refreshCustomAvailability();
    }

    /**
     * Re-check every saved custom variable against the connected simulation
     * and grey out the ones that are not available. With no simulation
     * connected the checks resolve 'unknown' immediately and nothing greys.
     */
    private async refreshCustomAvailability(): Promise<void> {
        if (this.customVars.length === 0) return;

        const results = await checkLogVariables(this.customVars, this.checkerDeps());
        results.forEach((result, name) => {
            // Keep the previous verdict on timeouts, so a slow echo round-trip
            // does not momentarily "un-grey" a known-missing variable.
            if (result !== 'unknown' || !this.customAvailability.has(name)) {
                this.customAvailability.set(name, result);
            }
        });
        this.renderVariableGrid();
        this.updatePreview();
    }

    private checkerDeps(): VariableCheckerDeps {
        return {
            sendCommand: (command: string) => window.app?.sendCommand(command),
            isConnected: () => connectionStatus.isBlueSkyConnected(),
        };
    }

    /** Selected preset + custom variables, in form order. */
    private collectVariables(): string[] {
        const variables: string[] = [];
        this.varGrid?.querySelectorAll<HTMLInputElement>('input[data-varname]').forEach(cb => {
            // Disabled = greyed out as unavailable in the current simulation
            if (cb.checked && !cb.disabled && cb.dataset.varname) {
                variables.push(cb.dataset.varname);
            }
        });
        // Text still sitting in the input (not yet added) counts too, so a
        // typed-but-unconfirmed variable is not silently dropped on submit.
        const custom = this.customVarsInput?.value ?? '';
        for (const token of custom.split(/[\s,]+/)) {
            if (token && !variables.includes(token)) variables.push(token);
        }
        return variables;
    }

    private setCustomStatus(message: string | null, kind: 'info' | 'success' | 'error' = 'info'): void {
        if (!this.customStatusEl) return;
        if (!message) {
            this.customStatusEl.textContent = '';
            this.customStatusEl.style.display = 'none';
            this.customStatusEl.classList.remove('success', 'error');
            return;
        }
        this.customStatusEl.textContent = message;
        this.customStatusEl.style.display = '';
        this.customStatusEl.classList.toggle('success', kind === 'success');
        this.customStatusEl.classList.toggle('error', kind === 'error');
    }

    /**
     * Validate the typed custom variable against the running simulation
     * (LSVAR round-trip) and add it to the grid + the persistent list.
     * 'not-found' blocks the add; 'unknown' (no simulation connected, or no
     * reply) adds it unverified.
     */
    public async addCustomVariable(): Promise<void> {
        const name = (this.customVarsInput?.value ?? '').trim();
        if (!name) {
            this.setCustomStatus('Type a variable name first (e.g. traf.perf.mass)', 'error');
            return;
        }
        if (!LOG_VARIABLE_NAME_PATTERN.test(name)) {
            this.setCustomStatus(`Invalid variable name: ${name}`, 'error');
            return;
        }
        if (LOG_VARIABLE_PRESETS.some(p => p.name === name) || this.customVars.includes(name)) {
            // Already listed: just make sure it is ticked
            const cb = this.varGrid?.querySelector<HTMLInputElement>(
                `input[data-varname="${CSS.escape(name)}"]`);
            if (cb && !cb.disabled) cb.checked = true;
            if (this.customVarsInput) this.customVarsInput.value = '';
            this.setCustomStatus(`${name} is already in the list`, 'info');
            this.updatePreview();
            return;
        }

        if (this.addVarBtn) this.addVarBtn.disabled = true;
        this.setCustomStatus(`Checking ${name} against the simulation…`, 'info');
        const result = await checkLogVariable(name, this.checkerDeps());
        if (this.addVarBtn) this.addVarBtn.disabled = false;

        if (result === 'not-found') {
            this.setCustomStatus(`${name} was not found in the current simulation (LSVAR)`, 'error');
            return;
        }

        this.customVars.push(name);
        this.customAvailability.set(name, result);
        storage.set(CreateLogManager.STORAGE_KEY, this.customVars);
        if (this.customVarsInput) {
            this.customVarsInput.value = '';
            this.customVarsInput.focus();
        }
        this.renderVariableGrid();
        this.updatePreview();
        this.setCustomStatus(
            result === 'found'
                ? `${name} added (verified in the running simulation)`
                : `${name} added (could not verify - no simulation reply)`,
            'success');
    }

    /** Forget a saved custom variable (removes it from the persistent list). */
    public removeCustomVariable(name: string): void {
        const index = this.customVars.indexOf(name);
        if (index === -1) return;
        this.customVars.splice(index, 1);
        this.customAvailability.delete(name);
        storage.set(CreateLogManager.STORAGE_KEY, this.customVars);
        this.renderVariableGrid();
        this.updatePreview();
        this.setCustomStatus(`${name} removed`, 'info');
    }

    /** The spec currently described by the dialog's form fields. */
    private currentSpec(): CreateLogSpec {
        return {
            name: (this.nameInput?.value ?? '').trim().toUpperCase(),
            dt: parseFloat(this.dtInput?.value ?? ''),
            header: (this.headerInput?.value ?? '').trim(),
            variables: this.collectVariables(),
            startNow: this.startCheckbox?.checked ?? true,
        };
    }

    private updatePreview(): void {
        if (!this.previewEl) return;
        const spec = this.currentSpec();
        if (!spec.name) {
            this.previewEl.textContent = 'Enter a log name…';
            return;
        }
        // Preview even while invalid; validation runs on submit.
        if (!Number.isFinite(spec.dt)) spec.dt = 1.0;
        this.previewEl.textContent = buildCreateLogCommands(spec).join('\n');
    }

    private showError(message: string | null): void {
        if (!this.errorEl) return;
        if (message) {
            this.errorEl.textContent = message;
            this.errorEl.style.display = '';
        } else {
            this.errorEl.textContent = '';
            this.errorEl.style.display = 'none';
        }
    }

    /**
     * A log name that matches an existing BlueSky stack command (POS, CRE,
     * ...) would overwrite that command when the logger registers its own, so
     * block it. Names of loggers created here are fine: CRELOG then fails with
     * "already exists" but ADD/ON still apply, which re-configures the logger.
     */
    private conflictsWithCommand(name: string): boolean {
        if (this.loggers.has(name)) return false;
        const cmddict = window.app?.getStateManager().getState().cmddict;
        return cmddict ? name in cmddict : false;
    }

    public async submit(): Promise<void> {
        const spec = this.currentSpec();

        const error = validateLogSpec(spec);
        if (error) {
            this.showError(error);
            return;
        }
        if (this.conflictsWithCommand(spec.name)) {
            this.showError(`"${spec.name}" is already a BlueSky command - choose another name`);
            return;
        }

        const commands = buildCreateLogCommands(spec);
        for (const command of commands) {
            await window.app?.sendCommand(command);
        }

        this.loggers.set(spec.name, { name: spec.name, dt: spec.dt, running: spec.startNow });
        this.renderQuickControls();

        echoManager.addMessage(
            `Log ${spec.name} created (${spec.variables.length} variables, every ${spec.dt}s)` +
            (spec.startNow ? ' and started' : ` - start it with "${spec.name} ON"`),
            'success', 'webatm');

        modalManager.close(CreateLogManager.MODAL_ID);
        if (spec.startNow) {
            this.scheduleFileListRefresh();
        }
    }

    private async toggleLogger(name: string): Promise<void> {
        const tracked = this.loggers.get(name);
        if (!tracked) return;

        tracked.running = !tracked.running;
        await window.app?.sendCommand(`${name} ${tracked.running ? 'ON' : 'OFF'}`);
        this.renderQuickControls();
        // Starting creates the file; stopping finalizes it - refresh either way.
        this.scheduleFileListRefresh();
    }

    private scheduleFileListRefresh(): void {
        setTimeout(() => {
            void window.outputFileBrowser?.refreshFileList();
        }, CreateLogManager.REFRESH_DELAY_MS);
    }

    private renderQuickControls(): void {
        if (!this.quickControlsEl) return;

        if (this.loggers.size === 0) {
            this.quickControlsEl.style.display = 'none';
            this.quickControlsEl.innerHTML = '';
            return;
        }

        const chips = Array.from(this.loggers.values()).map(l => `
            <span class="log-chip ${l.running ? 'running' : ''}" title="Data log ${escapeHtml(l.name)} (every ${l.dt}s)">
                <span class="log-chip-status"></span>
                <span class="log-chip-name">${escapeHtml(l.name)}</span>
                <span class="log-chip-dt">${l.dt}s</span>
                <button class="console-btn" data-action="toggle-log" data-log="${escapeHtml(l.name)}">${l.running ? 'Stop' : 'Start'}</button>
                <button class="log-chip-dismiss" data-action="dismiss-log" data-log="${escapeHtml(l.name)}" title="Remove from this list (the logger keeps existing in BlueSky)">&times;</button>
            </span>`).join('');

        this.quickControlsEl.innerHTML = chips;
        this.quickControlsEl.style.display = '';
    }

    /** Loggers created through this dialog in this browser session. */
    public getTrackedLoggers(): ReadonlyMap<string, { name: string; dt: number; running: boolean }> {
        return this.loggers;
    }
}

export const createLogManager = new CreateLogManager();
