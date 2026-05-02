/**
 * AircraftInfoPanel - Manages the Aircraft Info panel
 *
 * This panel handles:
 * - Displaying detailed information for selected aircraft
 * - Aircraft position, altitude, speed, heading
 * - Flight plan information
 * - Performance data
 * - Real-time updates from BlueSky server
 * - Copyable field values
 */

import { BasePanel } from '../BasePanel';
import { AircraftData, DisplayOptions } from '../../../data/types';
import { StateManager } from '../../../core/StateManager';
import { DataProcessor } from '../../../data/DataProcessor';
import { AUTO_MODEL_SENTINEL } from '../../../data/aircraftCategories';
import { logger } from '../../../utils/Logger';

interface ModelOption {
    filename: string;
    displayName: string;
}

export class AircraftInfoPanel extends BasePanel {
    private aircraftInfoElement: HTMLElement | null = null;
    private stateManager: StateManager | null = null;
    private currentAircraftData: AircraftData | null = null;
    private selectedAircraft: string | null = null;
    private displayOptions: DisplayOptions | null = null;

    // Persistent DOM references - built once and mutated on updates
    // to avoid destroying/recreating elements on every tick (which
    // caused flicker and interrupted click-to-copy interactions).
    private valueElements: Map<string, HTMLElement> = new Map();
    private tcpaRowElement: HTMLElement | null = null;
    private hasStructure = false;

    // Tracks fields currently displaying "Copied!" feedback so that
    // data updates do not overwrite the feedback message mid-animation.
    private copyFeedbackTimeouts: Map<string, number> = new Map();

    // Per-aircraft 3D model override UI state
    private modelSelect: HTMLSelectElement | null = null;
    private modelRowElement: HTMLElement | null = null;
    private availableModels: ModelOption[] = [];
    private modelsFetched = false;

    // Per-aircraft 3D scale override UI state
    private scaleInput: HTMLInputElement | null = null;
    private scaleRowElement: HTMLElement | null = null;

    constructor() {
        super('.aircraft-panel', 'aircraft-info-content');
    }

    protected onInit(): void {
        this.aircraftInfoElement = document.getElementById('aircraft-info');

        if (!this.aircraftInfoElement) {
            logger.warn('AircraftInfoPanel', 'Aircraft info element not found');
            return;
        }

        logger.debug('AircraftInfoPanel', 'AircraftInfoPanel initialized');
    }

    /**
     * Set the state manager to enable aircraft selection coordination
     */
    public setStateManager(stateManager: StateManager): void {
        this.stateManager = stateManager;

        // Get initial display options
        this.displayOptions = this.stateManager.getDisplayOptions();

        // Subscribe to selected aircraft changes
        this.stateManager.subscribe('selectedAircraft', (newAircraft) => {
            this.selectedAircraft = newAircraft;
            this.updateAircraftInfo();
        });

        // Subscribe to aircraft data updates
        this.stateManager.subscribe('aircraftData', (newData) => {
            this.currentAircraftData = newData;
            // Only update if an aircraft is selected
            if (this.selectedAircraft) {
                this.updateAircraftInfo();
            }
        });

        // Subscribe to display options changes (units, speed type, etc.)
        this.stateManager.subscribe('displayOptions', (newOptions) => {
            this.displayOptions = newOptions;
            // Update display if an aircraft is selected
            if (this.selectedAircraft) {
                this.updateAircraftInfo();
            } else {
                // Still sync 3D row visibility when overlay toggles
                this.apply3DRowVisibility();
            }
        });

        // Subscribe to per-aircraft model overrides so the dropdown
        // reflects external changes (e.g. cleared when the aircraft
        // disappears from the simulation).
        this.stateManager.subscribe('aircraftModelOverrides', () => {
            this.syncModelDropdown();
        });

        // Same for scale overrides — keep the input in sync when the
        // global scale changes (which clears overrides) or the aircraft
        // disappears.
        this.stateManager.subscribe('aircraftScaleOverrides', () => {
            this.syncScaleInput();
        });

        // Kick off the model list fetch so the dropdown is ready
        // the first time an aircraft is selected.
        void this.loadAvailableModels();
    }

    /**
     * Update panel with new data
     */
    public update(data?: AircraftData): void {
        if (data) {
            this.currentAircraftData = data;
        }
        if (this.selectedAircraft) {
            this.updateAircraftInfo();
        }
    }

    /**
     * Update aircraft info display
     */
    private updateAircraftInfo(): void {
        if (!this.aircraftInfoElement || !this.displayOptions) return;

        // If no aircraft selected, show placeholder
        if (!this.selectedAircraft || !this.currentAircraftData) {
            this.showPlaceholder('No aircraft selected');
            return;
        }

        // Find aircraft index
        const index = this.currentAircraftData.id.indexOf(this.selectedAircraft);

        if (index === -1) {
            // Aircraft not found in current data
            this.showPlaceholder('Aircraft not found');
            return;
        }

        // Build the static DOM structure on first render (or after a placeholder).
        // Subsequent updates only mutate text content, so elements and their
        // event listeners persist across ticks.
        if (!this.hasStructure) {
            this.buildInfoStructure();
        }

        const data = this.currentAircraftData;

        // Get aircraft data (in BlueSky units: alt in m, speeds in kt, vs in ft/s)
        const aircraftId = data.id[index];
        const aircraftType = data.actype && data.actype[index] ? data.actype[index] : 'N/A';
        const lat = data.lat[index];
        const lon = data.lon[index];
        const altMeters = data.alt[index];
        const casKnots = (data.cas && data.cas[index]) || null;  // May not be available from backend yet
        const tasKnots = data.tas[index];
        const gsKnots = (data.gs && data.gs[index]) || null;  // May not be available from backend yet
        const trk = data.trk[index];
        const vsFtPerSec = data.vs[index];
        const inconf = data.inconf[index];
        const tcpamax = data.tcpamax[index];

        // Format values using DataProcessor with current units
        const latStr = `${lat.toFixed(6)}°`;
        const lonStr = `${lon.toFixed(6)}°`;
        const altStr = DataProcessor.formatAltitude(altMeters, this.displayOptions.altitudeUnit);

        // Handle potentially missing speed data from backend
        const casStr = casKnots !== null
            ? DataProcessor.formatSpeed(casKnots, this.displayOptions.speedUnit)
            : `N/A (using TAS: ${DataProcessor.formatSpeed(tasKnots, this.displayOptions.speedUnit)})`;
        const tasStr = DataProcessor.formatSpeed(tasKnots, this.displayOptions.speedUnit);
        const gsStr = gsKnots !== null
            ? DataProcessor.formatSpeed(gsKnots, this.displayOptions.speedUnit)
            : `N/A (using TAS: ${DataProcessor.formatSpeed(tasKnots, this.displayOptions.speedUnit)})`;

        const trkStr = `${Math.round(trk)}°`;
        const vsStr = DataProcessor.formatVerticalSpeed(vsFtPerSec, this.displayOptions.verticalSpeedUnit);

        // Update copyable value fields in place
        this.setValueText('id', aircraftId);
        this.setValueText('actype', aircraftType);
        this.setValueText('lat', latStr);
        this.setValueText('lon', lonStr);
        this.setValueText('alt', altStr);
        this.setValueText('cas', casStr);
        this.setValueText('tas', tasStr);
        this.setValueText('gs', gsStr);
        this.setValueText('trk', trkStr);
        this.setValueText('vs', vsStr);

        // Conflict status (non-copyable, has dynamic class)
        const confEl = this.valueElements.get('conflict');
        if (confEl) {
            const confStatus = inconf ? 'CONFLICT' : 'Clear';
            const confClass = inconf ? 'info-value conflict-warning' : 'info-value conflict-clear';
            if (confEl.textContent !== confStatus) confEl.textContent = confStatus;
            if (confEl.className !== confClass) confEl.className = confClass;
        }

        // Keep the 3D model row in sync with the currently selected aircraft
        // and the 3D overlay toggle.
        this.syncModelDropdown();
        this.syncScaleInput();
        this.apply3DRowVisibility();

        // TCPA row - toggle visibility rather than adding/removing the element
        if (this.tcpaRowElement) {
            if (inconf) {
                if (this.tcpaRowElement.style.display === 'none') {
                    this.tcpaRowElement.style.display = '';
                }
                const tcpaEl = this.valueElements.get('tcpa');
                if (tcpaEl) {
                    const tcpaStr = tcpamax !== undefined ? `${tcpamax.toFixed(1)} s` : 'N/A';
                    if (tcpaEl.textContent !== tcpaStr) tcpaEl.textContent = tcpaStr;
                }
            } else if (this.tcpaRowElement.style.display !== 'none') {
                this.tcpaRowElement.style.display = 'none';
            }
        }
    }

    /**
     * Update a value element's text content, skipping the update if it
     * is currently showing "Copied!" feedback. In that case, the latest
     * value is stashed and restored when the feedback timeout expires.
     */
    private setValueText(field: string, text: string): void {
        const el = this.valueElements.get(field);
        if (!el) return;

        if (this.copyFeedbackTimeouts.has(field)) {
            el.setAttribute('data-pending-text', text);
            return;
        }

        if (el.textContent !== text) {
            el.textContent = text;
        }
    }

    /**
     * Show a placeholder message and tear down the info structure.
     */
    private showPlaceholder(msg: string): void {
        if (!this.aircraftInfoElement) return;
        this.clearStructure();
        this.aircraftInfoElement.innerHTML = `<div class="no-selection">${msg}</div>`;
    }

    /**
     * Release references to the info grid elements.
     */
    private clearStructure(): void {
        this.valueElements.clear();
        this.tcpaRowElement = null;
        this.modelSelect = null;
        this.modelRowElement = null;
        this.scaleInput = null;
        this.scaleRowElement = null;
        this.hasStructure = false;
        this.copyFeedbackTimeouts.forEach((id) => window.clearTimeout(id));
        this.copyFeedbackTimeouts.clear();
    }

    /**
     * Build the info grid once. Subsequent updates only mutate the text
     * content of the cached value elements, so event listeners and hover
     * state persist across data ticks.
     */
    private buildInfoStructure(): void {
        if (!this.aircraftInfoElement) return;

        this.aircraftInfoElement.innerHTML = '';
        this.valueElements.clear();

        const grid = document.createElement('div');
        grid.className = 'aircraft-info-grid';

        const copyableFields: Array<[string, string]> = [
            ['Aircraft ID:', 'id'],
            ['Aircraft Type:', 'actype'],
            ['Latitude:', 'lat'],
            ['Longitude:', 'lon'],
            ['Altitude:', 'alt'],
            ['CAS:', 'cas'],
            ['TAS:', 'tas'],
            ['GS:', 'gs'],
            ['Track:', 'trk'],
            ['Vertical Speed:', 'vs'],
        ];

        for (const [labelText, field] of copyableFields) {
            const row = this.createRow(labelText);
            const value = document.createElement('span');
            value.className = 'info-value copyable-value';
            value.setAttribute('data-field', field);
            this.attachCopyHandler(value, field);
            row.appendChild(value);
            grid.appendChild(row);
            this.valueElements.set(field, value);
        }

        // Conflict status row (non-copyable, class changes dynamically)
        const confRow = this.createRow('Conflict Status:');
        const confValue = document.createElement('span');
        confValue.className = 'info-value';
        confValue.setAttribute('data-field', 'conflict');
        confRow.appendChild(confValue);
        grid.appendChild(confRow);
        this.valueElements.set('conflict', confValue);

        // Time to CPA row - only visible when in conflict
        const tcpaRow = this.createRow('Time to CPA:');
        const tcpaValue = document.createElement('span');
        tcpaValue.className = 'info-value';
        tcpaValue.setAttribute('data-field', 'tcpa');
        tcpaRow.appendChild(tcpaValue);
        tcpaRow.style.display = 'none';
        grid.appendChild(tcpaRow);
        this.valueElements.set('tcpa', tcpaValue);
        this.tcpaRowElement = tcpaRow;

        // 3D model override row — dropdown lets the user pick a
        // specific GLTF/GLB for the selected aircraft, or "Auto" to
        // fall back to the per-type category selection.
        const modelRow = this.createRow('3D Model:');
        const modelSelect = document.createElement('select');
        modelSelect.className = 'aircraft-model-override';
        modelSelect.setAttribute('data-field', 'model-override');
        modelSelect.addEventListener('change', () => this.onModelSelectChange());
        modelRow.appendChild(modelSelect);
        grid.appendChild(modelRow);
        this.modelSelect = modelSelect;
        this.modelRowElement = modelRow;

        // 3D scale override row — text input accepts a positive number
        // to override this aircraft's scale. An empty value (or
        // anything invalid) clears the override and falls back to the
        // global aircraft3DScale setting.
        const scaleRow = this.createRow('3D Scale:');
        const scaleInput = document.createElement('input');
        scaleInput.type = 'text';
        scaleInput.className = 'aircraft-scale-override';
        scaleInput.setAttribute('data-field', 'scale-override');
        scaleInput.setAttribute('pattern', '[0-9]*\\.?[0-9]*');
        scaleInput.title = 'Enter positive number to override, or leave empty for Auto (global)';
        scaleInput.addEventListener('keydown', (e) => {
            if ((e as KeyboardEvent).key === 'Enter') {
                this.onScaleInputCommit();
                scaleInput.blur();
            }
        });
        scaleInput.addEventListener('blur', () => this.onScaleInputCommit());
        scaleRow.appendChild(scaleInput);
        grid.appendChild(scaleRow);
        this.scaleInput = scaleInput;
        this.scaleRowElement = scaleRow;

        this.aircraftInfoElement.appendChild(grid);
        this.hasStructure = true;

        this.populateModelDropdown();
        this.syncModelDropdown();
        this.syncScaleInput();
        this.apply3DRowVisibility();
    }

    private createRow(labelText: string): HTMLDivElement {
        const row = document.createElement('div');
        row.className = 'info-row';
        const label = document.createElement('span');
        label.className = 'info-label';
        label.textContent = labelText;
        row.appendChild(label);
        return row;
    }

    /**
     * Attach click-to-copy handler once per element. The element persists
     * across data updates, so this listener only needs to be bound once.
     */
    private attachCopyHandler(element: HTMLElement, field: string): void {
        element.addEventListener('click', async () => {
            const textToCopy = element.textContent || '';

            try {
                await navigator.clipboard.writeText(textToCopy);

                // If a previous feedback is still active, clear it first
                const existingTimeout = this.copyFeedbackTimeouts.get(field);
                if (existingTimeout !== undefined) {
                    window.clearTimeout(existingTimeout);
                }

                // Show feedback
                element.textContent = 'Copied!';
                element.style.color = '#4CAF50';

                const timeoutId = window.setTimeout(() => {
                    this.copyFeedbackTimeouts.delete(field);
                    element.style.color = '';
                    // Restore to the most recent value received during feedback,
                    // if any. Otherwise the next update tick will refresh it.
                    const pending = element.getAttribute('data-pending-text');
                    if (pending !== null) {
                        element.textContent = pending;
                        element.removeAttribute('data-pending-text');
                    }
                }, 1000);

                this.copyFeedbackTimeouts.set(field, timeoutId);

                logger.debug('AircraftInfoPanel', `Copied ${field}: ${textToCopy}`);
            } catch (err) {
                logger.error('AircraftInfoPanel', 'Failed to copy text:', err);
            }
        });
    }

    /**
     * Fetch the list of available 3D models once. Subsequent panel
     * rebuilds reuse the cached list.
     */
    private async loadAvailableModels(): Promise<void> {
        if (this.modelsFetched) return;
        try {
            const response = await fetch('/api/aircraft/models');
            if (!response.ok) {
                logger.warn('AircraftInfoPanel', 'Failed to fetch aircraft models');
                return;
            }
            const data = await response.json();
            if (data.success && Array.isArray(data.models)) {
                this.availableModels = data.models.map((m: { filename: string; displayName: string }) => ({
                    filename: m.filename,
                    displayName: m.displayName,
                }));
                this.modelsFetched = true;
                // Populate the dropdown if it already exists.
                this.populateModelDropdown();
                this.syncModelDropdown();
            }
        } catch (error) {
            logger.error('AircraftInfoPanel', `Error loading aircraft models: ${error}`);
        }
    }

    /**
     * Fill the override dropdown with "Auto" plus every known model.
     */
    private populateModelDropdown(): void {
        if (!this.modelSelect) return;
        this.modelSelect.innerHTML = '';

        const autoOption = document.createElement('option');
        autoOption.value = AUTO_MODEL_SENTINEL;
        autoOption.textContent = 'Auto (by aircraft type)';
        this.modelSelect.appendChild(autoOption);

        for (const model of this.availableModels) {
            const option = document.createElement('option');
            option.value = model.filename;
            option.textContent = model.displayName;
            this.modelSelect.appendChild(option);
        }
    }

    /**
     * Set the dropdown value to match the current override for the
     * selected aircraft (or Auto if none).
     */
    private syncModelDropdown(): void {
        if (!this.modelSelect || !this.stateManager || !this.selectedAircraft) return;
        const override = this.stateManager.getAircraftModelOverride(this.selectedAircraft);
        const desired = override ?? AUTO_MODEL_SENTINEL;
        if (this.modelSelect.value !== desired) {
            this.modelSelect.value = desired;
            // If the option isn't present (model list hasn't loaded yet),
            // the assignment is a no-op — populateModelDropdown will
            // call this method again once the fetch completes.
        }
    }

    /**
     * Show/hide the 3D model and scale rows based on the overlay toggle.
     */
    private apply3DRowVisibility(): void {
        if (!this.displayOptions) return;
        const shouldShow = !!this.displayOptions.show3DOverlay;
        const display = shouldShow ? '' : 'none';
        if (this.modelRowElement) this.modelRowElement.style.display = display;
        if (this.scaleRowElement) this.scaleRowElement.style.display = display;
    }

    /**
     * Set the scale input to reflect the current override for the
     * selected aircraft (empty when none — using global).
     */
    private syncScaleInput(): void {
        if (!this.scaleInput || !this.stateManager || !this.selectedAircraft) return;
        // Skip syncing while the user is editing the field to avoid
        // clobbering in-progress input.
        if (document.activeElement === this.scaleInput) return;
        const override = this.stateManager.getAircraftScaleOverride(this.selectedAircraft);
        const globalScale = this.displayOptions?.aircraft3DScale ?? 2.0;
        this.scaleInput.placeholder = `Auto (${globalScale}x)`;
        const desired = override !== null ? override.toString() : '';
        if (this.scaleInput.value !== desired) {
            this.scaleInput.value = desired;
        }
    }

    /**
     * Persist the user's scale choice (or clear it) on the selected
     * aircraft. Empty or invalid input clears the override so the
     * global aircraft3DScale applies.
     */
    private onScaleInputCommit(): void {
        if (!this.scaleInput || !this.stateManager || !this.selectedAircraft) return;
        const raw = this.scaleInput.value.trim();
        if (raw === '') {
            this.stateManager.setAircraftScaleOverride(this.selectedAircraft, null);
            this.syncScaleInput();
            return;
        }
        const value = parseFloat(raw);
        if (!isFinite(value) || value <= 0) {
            // Invalid — revert to whatever the current state is.
            this.syncScaleInput();
            logger.warn('AircraftInfoPanel', 'Invalid per-aircraft 3D scale, must be a positive number');
            return;
        }
        this.stateManager.setAircraftScaleOverride(this.selectedAircraft, value);
        logger.info(
            'AircraftInfoPanel',
            `3D scale override for ${this.selectedAircraft}: ${value}`
        );
    }

    /**
     * Persist the user's model choice (or clear it) on the
     * selected aircraft via StateManager.
     */
    private onModelSelectChange(): void {
        if (!this.modelSelect || !this.stateManager || !this.selectedAircraft) return;
        const value = this.modelSelect.value;
        const modelFile = value === AUTO_MODEL_SENTINEL ? null : value;
        this.stateManager.setAircraftModelOverride(this.selectedAircraft, modelFile);
        logger.info(
            'AircraftInfoPanel',
            `3D model override for ${this.selectedAircraft}: ${modelFile ?? 'Auto'}`
        );
    }

    /**
     * Clear the aircraft info display
     */
    public clearInfo(): void {
        if (this.aircraftInfoElement) {
            this.showPlaceholder('No aircraft selected');
        }
    }

    /**
     * Get currently displayed aircraft ID
     */
    public getDisplayedAircraft(): string | null {
        return this.selectedAircraft;
    }

    protected onDestroy(): void {
        this.copyFeedbackTimeouts.forEach((id) => window.clearTimeout(id));
        this.copyFeedbackTimeouts.clear();
        this.valueElements.clear();
        this.tcpaRowElement = null;
        this.hasStructure = false;
    }
}
