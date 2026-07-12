/**
 * DisplayOptionsPanel - Manages the Display Options panel: text sizes,
 * speed/altitude units, colors, collapsible sections, and the map display
 * toggles (aircraft, labels, routes, shapes, navdata). Every control
 * persists to localStorage and mirrors into StateManager's DisplayOptions.
 */

import { BasePanel } from '../BasePanel';
import { StateManager } from '../../../core/StateManager';
import { storage } from '../../../utils/StorageManager';
import { SpeedType, AircraftShapeType, DisplayOptions } from '../../../data/types';
import { AUTO_MODEL_SENTINEL } from '../../../data/aircraftCategories';
import { fetchAircraftModels, populateModelSelect } from '../../../data/aircraftModels';
import { logger } from '../../../utils/Logger';
import type { App } from '../../../core/App';

/** A checkbox wired to a storage key (= element ID) and a DisplayOptions flag. */
interface BooleanOptionSpec {
    id: string;
    stateKey: keyof DisplayOptions;
}

export class DisplayOptionsPanel extends BasePanel {
    private stateManager: StateManager | null = null;
    private app: App | null = null;

    /**
     * Master checkboxes and the sub-option checkboxes they drive. Used both
     * to wire the change handlers and to restore checkbox/sub-row visibility
     * from storage on load.
     */
    private static readonly MASTER_TOGGLES: ReadonlyArray<{
        id: string;
        stateKey: keyof DisplayOptions;
        subOptions: ReadonlyArray<BooleanOptionSpec>;
    }> = [
        { id: 'show-aircraft-labels', stateKey: 'showAircraftLabels', subOptions: [
            { id: 'show-aircraft-id', stateKey: 'showAircraftId' },
            { id: 'show-aircraft-speed', stateKey: 'showAircraftSpeed' },
            { id: 'show-aircraft-altitude', stateKey: 'showAircraftAltitude' },
            { id: 'show-aircraft-type', stateKey: 'showAircraftType' }
        ] },
        { id: 'show-routes', stateKey: 'showRoutes', subOptions: [
            { id: 'show-route-lines', stateKey: 'showRouteLines' },
            { id: 'show-route-labels', stateKey: 'showRouteLabels' },
            { id: 'show-route-points', stateKey: 'showRoutePoints' }
        ] },
        { id: 'show-shapes', stateKey: 'showShapes', subOptions: [
            { id: 'show-shape-fill', stateKey: 'showShapeFill' },
            { id: 'show-shape-lines', stateKey: 'showShapeLines' },
            { id: 'show-shape-labels', stateKey: 'showShapeLabels' }
        ] },
        { id: 'show-airports', stateKey: 'showAirports', subOptions: [
            { id: 'show-airport-icons', stateKey: 'showAirportIcons' },
            { id: 'show-airport-labels', stateKey: 'showAirportLabels' },
            { id: 'show-heliports', stateKey: 'showHeliports' },
            { id: 'show-runways', stateKey: 'showRunways' },
            { id: 'show-runway-labels', stateKey: 'showRunwayLabels' },
            { id: 'show-pavement', stateKey: 'showPavement' }
        ] },
        { id: 'show-waypoints', stateKey: 'showWaypoints', subOptions: [
            { id: 'show-waypoint-icons', stateKey: 'showWaypointIcons' },
            { id: 'show-waypoint-labels', stateKey: 'showWaypointLabels' }
        ] }
    ];

    /** Boolean options that are not driven by any master toggle. */
    private static readonly INDEPENDENT_BOOLEAN_OPTIONS: ReadonlyArray<BooleanOptionSpec> = [
        { id: 'show-aircraft', stateKey: 'showAircraft' },
        { id: 'show-aircraft-trails', stateKey: 'showAircraftTrails' },
        { id: 'show-protected-zones', stateKey: 'showProtectedZones' },
        { id: 'snap-to-navaids', stateKey: 'snapToNavaids' },
        { id: 'show-search-bar', stateKey: 'showSearchBar' }
    ];

    /**
     * Color pickers: element ID doubles as the storage key. Defaults match
     * the StateManager defaults.
     */
    private static readonly COLOR_OPTIONS: ReadonlyArray<{
        id: string;
        stateKey: keyof DisplayOptions;
        defaultColor: string;
    }> = [
        { id: 'aircraft-icon-color', stateKey: 'aircraftIconColor', defaultColor: '#00ff00' },
        { id: 'aircraft-labels-color', stateKey: 'aircraftLabelColor', defaultColor: '#0066cc' },
        { id: 'aircraft-selected-color', stateKey: 'aircraftSelectedColor', defaultColor: '#ff6600' },
        { id: 'aircraft-conflict-color', stateKey: 'aircraftConflictColor', defaultColor: '#ffa000' },
        { id: 'aircraft-trails-color', stateKey: 'aircraftTrailColor', defaultColor: '#0066cc' },
        { id: 'trail-conflict-color', stateKey: 'trailConflictColor', defaultColor: '#ffa000' },
        { id: 'protected-zones-color', stateKey: 'protectedZonesColor', defaultColor: '#00ff00' },
        { id: 'route-labels-color', stateKey: 'routeLabelsColor', defaultColor: '#ff00ff' },
        { id: 'route-points-color', stateKey: 'routePointsColor', defaultColor: '#ff00ff' },
        { id: 'route-lines-color', stateKey: 'routeLinesColor', defaultColor: '#ff00ff' },
        { id: 'shape-fill-color', stateKey: 'shapeFillColor', defaultColor: '#ff00ff' },
        { id: 'shape-lines-color', stateKey: 'shapeLinesColor', defaultColor: '#ff00ff' },
        { id: 'shape-labels-color', stateKey: 'shapeLabelsColor', defaultColor: '#ff00ff' }
    ];

    /** Collapsible sections: toggle button / content pair per storage key. */
    private static readonly SECTION_STATE_KEYS: Readonly<Record<string, keyof DisplayOptions>> = {
        'sizes-visible': 'sizesVisible',
        'colors-visible': 'colorsVisible',
        'units-visible': 'unitsVisible',
        'threeD-visible': 'threeDVisible'
    };

    constructor() {
        super('.display-panel', 'display-content');
    }

    protected onInit(): void {
        logger.debug('DisplayOptionsPanel', 'DisplayOptionsPanel initialized');
        // Initialization happens after setStateManager is called
    }

    /**
     * Set the state manager for coordinating with other panels
     */
    public setStateManager(stateManager: StateManager): void {
        this.stateManager = stateManager;

        this.loadSettings();

        this.setupTextSizeControls();
        this.setupSelectControls();
        this.setupRenderModeControl();
        this.setup3DScaleControl();
        this.setupAircraftModelControl();
        this.setupCollapsibleSections();
        this.setupColorControls();
        this.setupMapDisplayOptions();
    }

    /**
     * Set the app reference for accessing MapOverlay
     */
    public setApp(app: App): void {
        this.app = app;
    }

    /** Every persisted boolean option: masters, their sub-options, independents. */
    private static allBooleanOptions(): BooleanOptionSpec[] {
        const specs: BooleanOptionSpec[] = [];
        for (const { id, stateKey, subOptions } of DisplayOptionsPanel.MASTER_TOGGLES) {
            specs.push({ id, stateKey }, ...subOptions);
        }
        specs.push(...DisplayOptionsPanel.INDEPENDENT_BOOLEAN_OPTIONS);
        return specs;
    }

    /**
     * Read a stored scalar, falling back to the default for missing entries
     * (and, via ||, for falsy corrupted ones — a 0 font size is never valid).
     */
    private loadStored<T>(key: string, fallback: T): T {
        return storage.get<T>(key, fallback) || fallback;
    }

    /**
     * Restore all persisted settings into state and the panel's controls.
     */
    private loadSettings(): void {
        if (!this.stateManager) return;

        const defaults = this.stateManager.getDisplayOptions();
        const update: Partial<DisplayOptions> = {};
        const record = update as Record<string, unknown>;

        // Text sizes
        const headerFontSize = this.loadStored('header-font-size', defaults.headerFontSize);
        const consoleFontSize = this.loadStored('console-font-size', defaults.consoleFontSize);
        const panelFontSize = this.loadStored('panel-font-size', defaults.panelFontSize);
        update.headerFontSize = headerFontSize;
        update.consoleFontSize = consoleFontSize;
        update.panelFontSize = panelFontSize;

        this.applyTextSize('header', headerFontSize);
        this.applyTextSize('console', consoleFontSize);
        this.applyTextSize('echo', consoleFontSize);
        this.applyTextSize('panel', panelFontSize);
        this.updateTextSizeUI('header-font-size', 'header-font-size-value', headerFontSize);
        this.updateTextSizeUI('console-font-size', 'console-font-size-value', consoleFontSize);
        this.updateTextSizeUI('panel-font-size', 'panel-font-size-value', panelFontSize);

        // Speed type, units, and aircraft shape selects
        update.speedType = this.loadStored<SpeedType>('speed-type', defaults.speedType);
        update.speedUnit = this.loadStored('speed-unit', defaults.speedUnit);
        update.altitudeUnit = this.loadStored('altitude-unit', defaults.altitudeUnit);
        update.verticalSpeedUnit = this.loadStored('vertical-speed-unit', defaults.verticalSpeedUnit);
        update.aircraftShape = this.loadStored<AircraftShapeType>('aircraft-shape', defaults.aircraftShape);
        this.setInputValue('aircraft-speed-type-select', update.speedType);
        this.setInputValue('speed-unit-select', update.speedUnit);
        this.setInputValue('altitude-unit-select', update.altitudeUnit);
        this.setInputValue('vertical-speed-unit-select', update.verticalSpeedUnit);
        this.setInputValue('aircraft-shape-select', update.aircraftShape);

        // 3D overlay. Consume the legacy 'render-mode' entry exactly once:
        // it may only seed a missing 'show-3d-overlay', never override an
        // explicit later choice, so remove it after reading.
        let show3DOverlay = storage.get<boolean>('show-3d-overlay') ?? defaults.show3DOverlay;
        if (storage.has('render-mode')) {
            if (!storage.has('show-3d-overlay') && storage.get<string>('render-mode') === '3d') {
                show3DOverlay = true;
                storage.set('show-3d-overlay', true);
            }
            storage.remove('render-mode');
        }
        update.show3DOverlay = show3DOverlay;
        this.setChecked('show-3d-overlay', show3DOverlay);

        const aircraft3DScale = this.loadStored('aircraft-3d-scale', defaults.aircraft3DScale);
        update.aircraft3DScale = aircraft3DScale;
        this.setInputValue('aircraft-3d-scale', aircraft3DScale);

        update.selectedAircraftModel = this.loadStored('selected-aircraft-model', defaults.selectedAircraftModel);

        // Icon and map-label sizes
        const aircraftIconSize = this.loadStored('aircraft-icon-size', defaults.aircraftIconSize);
        update.aircraftIconSize = aircraftIconSize;
        this.setInputValue('aircraft-icon-size', aircraftIconSize);
        this.setText('icon-size-value', aircraftIconSize.toFixed(1));

        const mapLabelsTextSize = this.loadStored('map-labels-text-size', defaults.mapLabelsTextSize);
        update.mapLabelsTextSize = mapLabelsTextSize;
        this.setInputValue('map-labels-text-size', mapLabelsTextSize);
        this.setText('labels-size-value', mapLabelsTextSize.toString());

        // Colors
        for (const { id, stateKey } of DisplayOptionsPanel.COLOR_OPTIONS) {
            const color = this.loadStored(id, defaults[stateKey] as string);
            record[stateKey] = color;
            this.setInputValue(id, color);
        }

        // Boolean map options (?? keeps an explicitly stored false)
        for (const { id, stateKey } of DisplayOptionsPanel.allBooleanOptions()) {
            const value = storage.get<boolean>(id) ?? (defaults[stateKey] as boolean);
            record[stateKey] = value;
            this.setChecked(id, value);
        }

        // Sub-option rows collapse under an unchecked master
        for (const { stateKey, subOptions } of DisplayOptionsPanel.MASTER_TOGGLES) {
            this.toggleSubOptionContainers(
                subOptions.map(sub => `${sub.id}-container`),
                record[stateKey] as boolean
            );
        }

        // Collapsible sections
        for (const [storageKey, stateKey] of Object.entries(DisplayOptionsPanel.SECTION_STATE_KEYS)) {
            const visible = storage.get<boolean>(storageKey) ?? (defaults[stateKey] as boolean);
            record[stateKey] = visible;
            this.applyCollapsibleState(storageKey.replace(/-visible$/, '-controls'), visible);
        }

        this.stateManager.updateDisplayOptions(update);
    }

    /**
     * Setup text size controls (header, console & echo, panel)
     */
    private setupTextSizeControls(): void {
        this.bindInput('header-font-size', (value) => {
            this.updateTextSize('header', parseInt(value));
        });

        // Console & Echo font size (single control for both)
        this.bindInput('console-font-size', (value) => {
            const size = parseInt(value);
            this.updateTextSize('console', size);
            this.applyTextSize('echo', size);
        });

        this.bindInput('panel-font-size', (value) => {
            this.updateTextSize('panel', parseInt(value));
        });
    }

    /**
     * Apply, display, persist, and mirror a text size into state.
     */
    private updateTextSize(type: 'header' | 'console' | 'panel', size: number): void {
        if (!this.stateManager) return;

        this.applyTextSize(type, size);
        this.updateTextSizeUI(`${type}-font-size`, `${type}-font-size-value`, size);
        storage.set(`${type}-font-size`, size);
        this.stateManager.updateDisplayOptions({ [`${type}FontSize`]: size } as Partial<DisplayOptions>);
    }

    /**
     * Apply text size CSS variable
     */
    private applyTextSize(type: 'header' | 'console' | 'echo' | 'panel', size: number): void {
        document.documentElement.style.setProperty(`--${type}-font-size`, `${size}px`);

        // Console also updates input font size
        if (type === 'console') {
            document.documentElement.style.setProperty('--console-input-font-size', `${size}px`);
        }
    }

    /**
     * Update text size UI elements
     */
    private updateTextSizeUI(inputId: string, valueId: string, size: number): void {
        this.setInputValue(inputId, size);
        this.setText(valueId, size.toString());
    }

    /**
     * Setup the speed type, unit, and aircraft shape selects
     */
    private setupSelectControls(): void {
        this.bindSelectOption('aircraft-speed-type-select', 'speed-type', 'speedType');
        this.bindSelectOption('speed-unit-select', 'speed-unit', 'speedUnit');
        this.bindSelectOption('altitude-unit-select', 'altitude-unit', 'altitudeUnit');
        this.bindSelectOption('vertical-speed-unit-select', 'vertical-speed-unit', 'verticalSpeedUnit');
        this.bindSelectOption('aircraft-shape-select', 'aircraft-shape', 'aircraftShape');
    }

    private setupRenderModeControl(): void {
        this.bindCheckbox('show-3d-overlay', async (checked) => {
            storage.set('show-3d-overlay', checked);

            if (this.stateManager) {
                this.stateManager.updateDisplayOptions({ show3DOverlay: checked });
            }

            if (this.app) {
                const mapOverlay = this.app.getMapOverlay();
                if (mapOverlay) {
                    try {
                        logger.info('DisplayOptionsPanel', `${checked ? 'Enabling' : 'Disabling'} 3D overlay...`);
                        await mapOverlay.updateDisplayOptions({ show3DOverlay: checked });
                        logger.info('DisplayOptionsPanel', `3D overlay ${checked ? 'enabled' : 'disabled'} successfully`);
                    } catch (error) {
                        // Roll the checkbox and state back so UI matches reality
                        logger.error('DisplayOptionsPanel', `Failed to toggle 3D overlay: ${error}`);
                        this.setChecked('show-3d-overlay', !checked);
                        if (this.stateManager) {
                            this.stateManager.updateDisplayOptions({ show3DOverlay: !checked });
                        }
                    }
                }
            }

            // Reveal the 3D controls section when the overlay turns on
            if (checked) {
                const threeDControls = document.getElementById('threeD-controls');
                if (threeDControls && threeDControls.style.display === 'none') {
                    this.toggleCollapsibleSection('threeD-controls', 'threeD-visible');
                }
            }
        });
    }

    private setup3DScaleControl(): void {
        // Apply on Enter (then drop focus) and on blur
        this.bindEvent('aircraft-3d-scale', 'keydown', (e) => {
            if ((e as KeyboardEvent).key === 'Enter') {
                const inputElement = e.target as HTMLInputElement;
                this.apply3DScaleValue(inputElement);
                inputElement.blur();
            }
        });
        this.bindEvent('aircraft-3d-scale', 'blur', (e) => {
            this.apply3DScaleValue(e.target as HTMLInputElement);
        });
    }

    /**
     * Apply and validate 3D aircraft scale value
     */
    private apply3DScaleValue(inputElement: HTMLInputElement): void {
        const raw = inputElement.value.trim();
        const value = parseFloat(raw);

        // Reject empty or non-positive input: restore the last valid value
        if (isNaN(value) || value <= 0) {
            const currentScale = this.stateManager?.getDisplayOptions().aircraft3DScale || 2.0;
            inputElement.value = currentScale.toString();
            if (raw !== '') {
                logger.warn('DisplayOptionsPanel', 'Invalid 3D aircraft scale, must be a positive number');
            }
            return;
        }

        storage.set('aircraft-3d-scale', value);
        this.stateManager?.updateDisplayOptions({ aircraft3DScale: value });
        logger.debug('DisplayOptionsPanel', `3D aircraft scale updated to: ${value}x`);
    }

    private setupAircraftModelControl(): void {
        this.loadAvailableAircraftModels();

        this.bindChange('aircraft-model-select', (selectedModel) => {
            if (this.stateManager) {
                storage.set('selected-aircraft-model', selectedModel);
                this.stateManager.updateDisplayOptions({ selectedAircraftModel: selectedModel });
                logger.info('DisplayOptionsPanel', `Aircraft model changed to: ${selectedModel}`);
            }
        });
    }

    private async loadAvailableAircraftModels(): Promise<void> {
        const models = await fetchAircraftModels();
        if (models.length === 0) return;

        const aircraftModelSelect = document.getElementById('aircraft-model-select') as HTMLSelectElement | null;
        if (!aircraftModelSelect) return;

        // Selects the saved model, falling back to Auto when it's unknown
        const savedModel = this.stateManager?.getDisplayOptions().selectedAircraftModel || AUTO_MODEL_SENTINEL;
        populateModelSelect(aircraftModelSelect, models, savedModel);
        logger.debug('DisplayOptionsPanel', `Loaded ${models.length} aircraft models`);
    }

    /**
     * Setup collapsible sections (Text Sizes, Colors, Units, 3D)
     */
    private setupCollapsibleSections(): void {
        this.bindClick('sizes-toggle', () => this.toggleCollapsibleSection('sizes-controls', 'sizes-visible'));
        this.bindClick('colors-toggle', () => this.toggleCollapsibleSection('colors-controls', 'colors-visible'));
        this.bindClick('units-toggle', () => this.toggleCollapsibleSection('units-controls', 'units-visible'));
        this.bindClick('threeD-toggle', () => this.toggleCollapsibleSection('threeD-controls', 'threeD-visible'));
    }

    /**
     * Toggle a collapsible section
     */
    private toggleCollapsibleSection(sectionId: string, storageKey: string): void {
        const section = document.getElementById(sectionId);
        if (!section || !this.stateManager) return;

        const newVisibility = !section.classList.contains('open');
        this.applyCollapsibleState(sectionId, newVisibility);

        if (newVisibility) {
            // Once the expand animation has finished, make sure the section
            // is visible within the scrollable panel
            window.setTimeout(() => {
                section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }, 240);
        }

        storage.set(storageKey, newVisibility);

        const stateKey = DisplayOptionsPanel.SECTION_STATE_KEYS[storageKey];
        if (stateKey) {
            this.stateManager.updateDisplayOptions({ [stateKey]: newVisibility } as Partial<DisplayOptions>);
        }
    }

    /**
     * Apply collapsible section state
     */
    private applyCollapsibleState(sectionId: string, isVisible: boolean): void {
        const section = document.getElementById(sectionId);
        if (!section) return;

        // Take over from the pre-paint script in index.html, which may have
        // opened this section at the html level before the bundle loaded
        document.documentElement.classList.remove(`wa-open-${sectionId}`);

        section.classList.toggle('open', isVisible);

        const toggleBtn = document.getElementById(sectionId.replace(/-controls$/, '-toggle'));
        toggleBtn?.classList.toggle('open', isVisible);
    }

    /**
     * Setup color controls
     */
    private setupColorControls(): void {
        for (const { id, stateKey } of DisplayOptionsPanel.COLOR_OPTIONS) {
            this.bindInput(id, (color) => {
                storage.set(id, color);
                this.stateManager?.updateDisplayOptions({ [stateKey]: color } as Partial<DisplayOptions>);
            });
        }

        this.bindClick('reset-colors-btn', () => this.resetColorsToDefaults());
    }

    /**
     * Reset all colors to default values
     */
    private resetColorsToDefaults(): void {
        if (!this.stateManager) return;

        const update: Partial<DisplayOptions> = {};
        for (const { id, stateKey, defaultColor } of DisplayOptionsPanel.COLOR_OPTIONS) {
            storage.set(id, defaultColor);
            this.setInputValue(id, defaultColor);
            (update as Record<string, unknown>)[stateKey] = defaultColor;
        }
        this.stateManager.updateDisplayOptions(update);

        logger.debug('DisplayOptionsPanel', 'Colors reset to defaults');
    }

    /**
     * Wire a checkbox that persists to storage (key = element ID) and
     * mirrors into a DisplayOptions flag.
     */
    private bindBooleanOption(id: string, stateKey: keyof DisplayOptions): void {
        this.bindCheckbox(id, (checked) => {
            storage.set(id, checked);
            this.stateManager?.updateDisplayOptions({ [stateKey]: checked } as Partial<DisplayOptions>);
        });
    }

    /**
     * Wire a master checkbox that drives a group of sub-option checkboxes:
     * persists every key, syncs the sub checkboxes and their
     * `<sub-id>-container` visibility, and pushes one combined state update.
     */
    private bindMasterToggle(
        id: string,
        stateKey: keyof DisplayOptions,
        subOptions: ReadonlyArray<BooleanOptionSpec>
    ): void {
        this.bindCheckbox(id, (checked) => {
            storage.set(id, checked);
            const update: Partial<DisplayOptions> = { [stateKey]: checked } as Partial<DisplayOptions>;
            for (const sub of subOptions) {
                storage.set(sub.id, checked);
                this.setChecked(sub.id, checked);
                (update as Record<string, unknown>)[sub.stateKey] = checked;
            }
            this.toggleSubOptionContainers(subOptions.map(sub => `${sub.id}-container`), checked);
            this.stateManager?.updateDisplayOptions(update);
        });
    }

    /**
     * Wire a select that persists to storage under its own key and mirrors
     * into a DisplayOptions field.
     */
    private bindSelectOption(id: string, storageKey: string, stateKey: keyof DisplayOptions): void {
        this.bindChange(id, (value) => {
            if (this.stateManager) {
                this.stateManager.updateDisplayOptions({ [stateKey]: value } as Partial<DisplayOptions>);
                storage.set(storageKey, value);
            }
        });
    }

    /**
     * Toggle visibility of sub-option containers
     */
    private toggleSubOptionContainers(containerIds: string[], visible: boolean): void {
        const display = visible ? 'block' : 'none';
        containerIds.forEach(containerId => {
            const container = document.getElementById(containerId);
            if (container) {
                container.style.display = display;
            }
        });
    }

    /**
     * Setup map display options (aircraft, labels, routes, shapes, navdata)
     */
    private setupMapDisplayOptions(): void {
        // Master toggles drive their sub-option checkboxes and containers;
        // each sub-option also remains individually togglable.
        for (const { id, stateKey, subOptions } of DisplayOptionsPanel.MASTER_TOGGLES) {
            this.bindMasterToggle(id, stateKey, subOptions);
            for (const sub of subOptions) {
                this.bindBooleanOption(sub.id, sub.stateKey);
            }
        }
        for (const { id, stateKey } of DisplayOptionsPanel.INDEPENDENT_BOOLEAN_OPTIONS) {
            this.bindBooleanOption(id, stateKey);
        }

        // Aircraft icon size
        this.bindInput('aircraft-icon-size', (value) => {
            const size = parseFloat(value);
            this.setText('icon-size-value', size.toFixed(1));
            storage.set('aircraft-icon-size', size);
            this.stateManager?.updateDisplayOptions({ aircraftIconSize: size });
        });

        // Map labels text size
        this.bindInput('map-labels-text-size', (value) => {
            const size = parseInt(value);
            this.setText('labels-size-value', size.toString());
            storage.set('map-labels-text-size', size);
            this.stateManager?.updateDisplayOptions({ mapLabelsTextSize: size });
        });
    }

    public update(): void {
        // No periodic updates needed for this panel
    }
}
