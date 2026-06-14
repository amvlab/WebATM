/**
 * DisplayOptionsPanel - Manages the Display Options panel
 *
 * This panel handles:
 * - Text size controls (console, echo, panel fonts)
 * - Speed type selection (CAS/TAS/GS)
 * - Unit controls (speed, altitude, vertical speed)
 * - Collapsible sections (Text Sizes, Colors, Units)
 * - Future map display options (stored but not yet functional)
 */

import { BasePanel } from '../BasePanel';
import { StateManager } from '../../../core/StateManager';
import { storage } from '../../../utils/StorageManager';
import { SpeedType, SpeedUnit, AltitudeUnit, VerticalSpeedUnit, AircraftShapeType, DisplayOptions } from '../../../data/types';
import { AUTO_MODEL_SENTINEL } from '../../../data/aircraftCategories';
import { fetchAircraftModels, populateModelSelect } from '../../../data/aircraftModels';
import { logger } from '../../../utils/Logger';
import type { App } from '../../../core/App';

export class DisplayOptionsPanel extends BasePanel {
    private stateManager: StateManager | null = null;
    private app: App | null = null;

    constructor() {
        super('.display-panel', 'display-content');
    }

    protected onInit(): void {
        logger.debug('DisplayOptionsPanel', 'DisplayOptionsPanel initialized');
        // Initialization will happen after setStateManager is called
    }

    /**
     * Set the state manager for coordinating with other panels
     */
    public setStateManager(stateManager: StateManager): void {
        this.stateManager = stateManager;

        // Load saved settings from localStorage
        this.loadSettings();

        // Setup all event listeners
        this.setupTextSizeControls();
        this.setupSpeedTypeControl();
        this.setupUnitControls();
        this.setupAircraftShapeControl();
        this.setupRenderModeControl();
        this.setup3DScaleControl();
        this.setupAircraftModelControl();
        this.setupCollapsibleSections();
        this.setupColorControls();
        this.setupFutureMapOptions();
    }

    /**
     * Set the app reference for accessing MapOverlay
     */
    public setApp(app: App): void {
        this.app = app;
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
        subOptions: Array<{ id: string; stateKey: keyof DisplayOptions }>
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
     * Load saved settings from localStorage
     */
    private loadSettings(): void {
        if (!this.stateManager) return;

        const displayOptions = this.stateManager.getDisplayOptions();

        // Load text sizes from storage (use || to handle null from storage)
        const headerFontSize = storage.get<number>('header-font-size', displayOptions.headerFontSize) || displayOptions.headerFontSize;
        const consoleFontSize = storage.get<number>('console-font-size', displayOptions.consoleFontSize) || displayOptions.consoleFontSize;
        const panelFontSize = storage.get<number>('panel-font-size', displayOptions.panelFontSize) || displayOptions.panelFontSize;

        // Load speed type from storage
        const speedType = storage.get<SpeedType>('speed-type', displayOptions.speedType) || displayOptions.speedType;

        // Load units from storage
        const speedUnit = storage.get<SpeedUnit>('speed-unit', displayOptions.speedUnit) || displayOptions.speedUnit;
        const altitudeUnit = storage.get<AltitudeUnit>('altitude-unit', displayOptions.altitudeUnit) || displayOptions.altitudeUnit;
        const verticalSpeedUnit = storage.get<VerticalSpeedUnit>('vertical-speed-unit', displayOptions.verticalSpeedUnit) || displayOptions.verticalSpeedUnit;

        // Load aircraft shape from storage
        const aircraftShape = storage.get<AircraftShapeType>('aircraft-shape', displayOptions.aircraftShape) || displayOptions.aircraftShape;

        // Load 3D overlay setting from storage. Also supports legacy
        // 'render-mode' setting for backwards compatibility.
        let show3DOverlay = storage.get<boolean>('show-3d-overlay') ?? displayOptions.show3DOverlay;
        // Migrate from old render-mode setting if present
        const legacyRenderMode = storage.get<string>('render-mode');
        if (legacyRenderMode === '3d' && show3DOverlay === false) {
            show3DOverlay = true;
            storage.set('show-3d-overlay', true);
        }

        // Load aircraft 3D scale from storage
        const aircraft3DScale = storage.get<number>('aircraft-3d-scale', displayOptions.aircraft3DScale) || displayOptions.aircraft3DScale;

        // Load aircraft icon size from storage
        const aircraftIconSize = storage.get<number>('aircraft-icon-size', displayOptions.aircraftIconSize) || displayOptions.aircraftIconSize;

        // Load map labels text size from storage
        const mapLabelsTextSize = storage.get<number>('map-labels-text-size', displayOptions.mapLabelsTextSize) || displayOptions.mapLabelsTextSize;

        // Load colors from storage
        const aircraftIconColor = storage.get<string>('aircraft-icon-color', displayOptions.aircraftIconColor) || displayOptions.aircraftIconColor;
        const aircraftLabelColor = storage.get<string>('aircraft-labels-color', displayOptions.aircraftLabelColor) || displayOptions.aircraftLabelColor;
        const aircraftSelectedColor = storage.get<string>('aircraft-selected-color', displayOptions.aircraftSelectedColor) || displayOptions.aircraftSelectedColor;
        const aircraftConflictColor = storage.get<string>('aircraft-conflict-color', displayOptions.aircraftConflictColor) || displayOptions.aircraftConflictColor;
        const aircraftTrailColor = storage.get<string>('aircraft-trails-color', displayOptions.aircraftTrailColor) || displayOptions.aircraftTrailColor;
        const trailConflictColor = storage.get<string>('trail-conflict-color', displayOptions.trailConflictColor) || displayOptions.trailConflictColor;
        const protectedZonesColor = storage.get<string>('protected-zones-color', displayOptions.protectedZonesColor) || displayOptions.protectedZonesColor;
        const routeLabelsColor = storage.get<string>('route-labels-color', displayOptions.routeLabelsColor) || displayOptions.routeLabelsColor;
        const routePointsColor = storage.get<string>('route-points-color', displayOptions.routePointsColor) || displayOptions.routePointsColor;
        const routeLinesColor = storage.get<string>('route-lines-color', displayOptions.routeLinesColor) || displayOptions.routeLinesColor;
        const shapeFillColor = storage.get<string>('shape-fill-color', displayOptions.shapeFillColor) || displayOptions.shapeFillColor;
        const shapeLinesColor = storage.get<string>('shape-lines-color', displayOptions.shapeLinesColor) || displayOptions.shapeLinesColor;
        const shapeLabelsColor = storage.get<string>('shape-labels-color', displayOptions.shapeLabelsColor) || displayOptions.shapeLabelsColor;

        // Load collapsible section states (special handling for boolean)
        const sizesVisible = storage.get<boolean>('sizes-visible') ?? displayOptions.sizesVisible;
        const colorsVisible = storage.get<boolean>('colors-visible') ?? displayOptions.colorsVisible;
        const unitsVisible = storage.get<boolean>('units-visible') ?? displayOptions.unitsVisible;
        const threeDVisible = storage.get<boolean>('threeD-visible') ?? displayOptions.threeDVisible;

        const selectedAircraftModel = storage.get<string>('selected-aircraft-model', displayOptions.selectedAircraftModel) || displayOptions.selectedAircraftModel;

        // Load aircraft display options from storage
        const showAircraft = storage.get<boolean>('show-aircraft') ?? displayOptions.showAircraft;
        const showAircraftLabels = storage.get<boolean>('show-aircraft-labels') ?? displayOptions.showAircraftLabels;
        const showAircraftId = storage.get<boolean>('show-aircraft-id') ?? displayOptions.showAircraftId;
        const showAircraftSpeed = storage.get<boolean>('show-aircraft-speed') ?? displayOptions.showAircraftSpeed;
        const showAircraftAltitude = storage.get<boolean>('show-aircraft-altitude') ?? displayOptions.showAircraftAltitude;
        const showAircraftType = storage.get<boolean>('show-aircraft-type') ?? displayOptions.showAircraftType;
        const showAircraftTrails = storage.get<boolean>('show-aircraft-trails') ?? displayOptions.showAircraftTrails;
        const showProtectedZones = storage.get<boolean>('show-protected-zones') ?? displayOptions.showProtectedZones;

        // Load shape display options from storage
        const showShapes = storage.get<boolean>('show-shapes') ?? displayOptions.showShapes;
        const showShapeFill = storage.get<boolean>('show-shape-fill') ?? displayOptions.showShapeFill;
        const showShapeLines = storage.get<boolean>('show-shape-lines') ?? displayOptions.showShapeLines;
        const showShapeLabels = storage.get<boolean>('show-shape-labels') ?? displayOptions.showShapeLabels;

        // Load navdata (airports/waypoints) display options from storage
        const showAirports = storage.get<boolean>('show-airports') ?? displayOptions.showAirports;
        const showAirportIcons = storage.get<boolean>('show-airport-icons') ?? displayOptions.showAirportIcons;
        const showAirportLabels = storage.get<boolean>('show-airport-labels') ?? displayOptions.showAirportLabels;
        const showHeliports = storage.get<boolean>('show-heliports') ?? displayOptions.showHeliports;
        const showWaypoints = storage.get<boolean>('show-waypoints') ?? displayOptions.showWaypoints;
        const showWaypointIcons = storage.get<boolean>('show-waypoint-icons') ?? displayOptions.showWaypointIcons;
        const showWaypointLabels = storage.get<boolean>('show-waypoint-labels') ?? displayOptions.showWaypointLabels;
        const showRunways = storage.get<boolean>('show-runways') ?? displayOptions.showRunways;
        const showRunwayLabels = storage.get<boolean>('show-runway-labels') ?? displayOptions.showRunwayLabels;
        const showPavement = storage.get<boolean>('show-pavement') ?? displayOptions.showPavement;
        const snapToNavaids = storage.get<boolean>('snap-to-navaids') ?? displayOptions.snapToNavaids;
        const showSearchBar = storage.get<boolean>('show-search-bar') ?? displayOptions.showSearchBar;

        // Load route display options from storage
        const showRoutes = storage.get<boolean>('show-routes') ?? displayOptions.showRoutes;
        const showRouteLines = storage.get<boolean>('show-route-lines') ?? displayOptions.showRouteLines;
        const showRouteLabels = storage.get<boolean>('show-route-labels') ?? displayOptions.showRouteLabels;
        const showRoutePoints = storage.get<boolean>('show-route-points') ?? displayOptions.showRoutePoints;

        // Update state manager with loaded values
        this.stateManager.updateDisplayOptions({
            headerFontSize,
            consoleFontSize,
            panelFontSize,
            speedType,
            speedUnit,
            altitudeUnit,
            verticalSpeedUnit,
            aircraftShape,
            show3DOverlay,
            aircraft3DScale,
            aircraftIconSize,
            mapLabelsTextSize,
            aircraftIconColor,
            aircraftLabelColor,
            aircraftSelectedColor,
            aircraftConflictColor,
            aircraftTrailColor,
            trailConflictColor,
            protectedZonesColor,
            routeLabelsColor,
            routePointsColor,
            routeLinesColor,
            shapeFillColor,
            shapeLinesColor,
            shapeLabelsColor,
            sizesVisible,
            colorsVisible,
            unitsVisible,
            threeDVisible,
            selectedAircraftModel,
            showAircraft,
            showAircraftLabels,
            showAircraftId,
            showAircraftSpeed,
            showAircraftAltitude,
            showAircraftType,
            showAircraftTrails,
            showProtectedZones,
            showShapes,
            showShapeFill,
            showShapeLines,
            showShapeLabels,
            showAirports,
            showAirportIcons,
            showAirportLabels,
            showHeliports,
            showWaypoints,
            showWaypointIcons,
            showWaypointLabels,
            showRunways,
            showRunwayLabels,
            showPavement,
            snapToNavaids,
            showSearchBar,
            showRoutes,
            showRouteLines,
            showRouteLabels,
            showRoutePoints
        });

        // Apply text sizes immediately
        this.applyTextSize('header', headerFontSize);
        this.applyTextSize('console', consoleFontSize);
        this.applyTextSize('echo', consoleFontSize);
        this.applyTextSize('panel', panelFontSize);

        // Update UI elements to reflect loaded values
        this.updateTextSizeUI('header-font-size', 'header-font-size-value', headerFontSize);
        this.updateTextSizeUI('console-font-size', 'console-font-size-value', consoleFontSize);
        this.updateTextSizeUI('panel-font-size', 'panel-font-size-value', panelFontSize);

        // Update dropdown values
        this.setInputValue('aircraft-speed-type-select', speedType);
        this.setInputValue('speed-unit-select', speedUnit);
        this.setInputValue('altitude-unit-select', altitudeUnit);
        this.setInputValue('vertical-speed-unit-select', verticalSpeedUnit);
        this.setInputValue('aircraft-shape-select', aircraftShape);

        this.setChecked('show-3d-overlay', show3DOverlay);
        this.setInputValue('aircraft-3d-scale', aircraft3DScale);

        // Update aircraft icon size UI
        this.setInputValue('aircraft-icon-size', aircraftIconSize);
        this.setText('icon-size-value', aircraftIconSize.toFixed(1));

        // Update map labels text size UI
        this.setInputValue('map-labels-text-size', mapLabelsTextSize);
        this.setText('labels-size-value', mapLabelsTextSize.toString());

        // Update aircraft display checkboxes to reflect loaded values
        this.setChecked('show-aircraft', showAircraft);
        this.setChecked('show-aircraft-labels', showAircraftLabels);
        this.setChecked('show-aircraft-id', showAircraftId);
        this.setChecked('show-aircraft-speed', showAircraftSpeed);
        this.setChecked('show-aircraft-altitude', showAircraftAltitude);
        this.setChecked('show-aircraft-type', showAircraftType);
        this.setChecked('show-aircraft-trails', showAircraftTrails);
        this.setChecked('show-protected-zones', showProtectedZones);

        // Update shape display checkboxes to reflect loaded values
        this.setChecked('show-shapes', showShapes);
        this.setChecked('show-shape-fill', showShapeFill);
        this.setChecked('show-shape-lines', showShapeLines);
        this.setChecked('show-shape-labels', showShapeLabels);

        // Update navdata (airports/waypoints) checkboxes to reflect loaded values
        this.setChecked('show-airports', showAirports);
        this.setChecked('show-airport-icons', showAirportIcons);
        this.setChecked('show-airport-labels', showAirportLabels);
        this.setChecked('show-heliports', showHeliports);
        this.setChecked('show-waypoints', showWaypoints);
        this.setChecked('show-waypoint-icons', showWaypointIcons);
        this.setChecked('show-waypoint-labels', showWaypointLabels);

        // Reflect master-toggle collapse state for the airport/waypoint groups
        this.toggleSubOptionContainers([
            'show-airport-icons-container',
            'show-airport-labels-container',
            'show-heliports-container',
            'show-runways-container',
            'show-runway-labels-container',
            'show-pavement-container'
        ], showAirports);
        this.toggleSubOptionContainers([
            'show-waypoint-icons-container',
            'show-waypoint-labels-container'
        ], showWaypoints);

        this.setChecked('show-runways', showRunways);
        this.setChecked('show-runway-labels', showRunwayLabels);
        this.setChecked('show-pavement', showPavement);
        this.setChecked('snap-to-navaids', snapToNavaids);
        this.setChecked('show-search-bar', showSearchBar);

        // Update route display checkboxes to reflect loaded values
        this.setChecked('show-routes', showRoutes);
        this.setChecked('show-route-lines', showRouteLines);
        this.setChecked('show-route-labels', showRouteLabels);
        this.setChecked('show-route-points', showRoutePoints);

        // Update color picker values to reflect loaded colors
        this.setInputValue('aircraft-icon-color', aircraftIconColor);
        this.setInputValue('aircraft-labels-color', aircraftLabelColor);
        this.setInputValue('aircraft-selected-color', aircraftSelectedColor);
        this.setInputValue('aircraft-conflict-color', aircraftConflictColor);
        this.setInputValue('aircraft-trails-color', aircraftTrailColor);
        this.setInputValue('trail-conflict-color', trailConflictColor);
        this.setInputValue('protected-zones-color', protectedZonesColor);
        this.setInputValue('route-labels-color', routeLabelsColor);
        this.setInputValue('route-points-color', routePointsColor);
        this.setInputValue('route-lines-color', routeLinesColor);
        this.setInputValue('shape-fill-color', shapeFillColor);
        this.setInputValue('shape-lines-color', shapeLinesColor);
        this.setInputValue('shape-labels-color', shapeLabelsColor);

        // Apply collapsible section states
        this.applyCollapsibleState('sizes-controls', sizesVisible);
        this.applyCollapsibleState('colors-controls', colorsVisible);
        this.applyCollapsibleState('units-controls', unitsVisible);
        this.applyCollapsibleState('threeD-controls', threeDVisible);
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
     * Update text size for a specific element type
     */
    private updateTextSize(type: 'header' | 'console' | 'echo' | 'panel', size: number): void {
        if (!this.stateManager) return;

        // Apply CSS variable
        this.applyTextSize(type, size);

        // Update display value
        this.updateTextSizeUI(`${type}-font-size`, `${type}-font-size-value`, size);

        // Save to storage
        storage.set(`${type}-font-size`, size);

        // Update state manager. Note `${type}FontSize` can be 'echoFontSize',
        // which is not a DisplayOptions key (echo follows the console size in
        // state); the record type keeps that historical write explicit.
        const update: Partial<Record<`${typeof type}FontSize`, number>> = {};
        update[`${type}FontSize`] = size;
        this.stateManager.updateDisplayOptions(update);
    }

    /**
     * Apply text size CSS variable
     */
    private applyTextSize(type: 'header' | 'console' | 'echo' | 'panel', size: number): void {
        const cssVar = `--${type}-font-size`;
        document.documentElement.style.setProperty(cssVar, `${size}px`);

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
     * Setup speed type control (CAS/TAS/GS)
     */
    private setupSpeedTypeControl(): void {
        this.bindSelectOption('aircraft-speed-type-select', 'speed-type', 'speedType');
    }

    /**
     * Setup aircraft shape control
     */
    private setupAircraftShapeControl(): void {
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
                        logger.error('DisplayOptionsPanel', `Failed to toggle 3D overlay: ${error}`);
                        this.setChecked('show-3d-overlay', !checked);
                        if (this.stateManager) {
                            this.stateManager.updateDisplayOptions({ show3DOverlay: !checked });
                        }
                    }
                }
            }

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
        const inputValue = inputElement.value.trim();
        
        // Allow empty input temporarily (user might be clearing to type new value)
        if (inputValue === '') {
            const currentScale = this.stateManager?.getDisplayOptions().aircraft3DScale || 2.0;
            inputElement.value = currentScale.toString();
            return;
        }

        const value = parseFloat(inputValue);

        // Validate input: must be a positive number
        if (isNaN(value) || value <= 0) {
            // Reset to previous valid value
            const currentScale = this.stateManager?.getDisplayOptions().aircraft3DScale || 2.0;
            inputElement.value = currentScale.toString();
            logger.warn('DisplayOptionsPanel', 'Invalid 3D aircraft scale, must be a positive number');
            return;
        }

        // Save to storage
        storage.set('aircraft-3d-scale', value);

        // Update state manager
        if (this.stateManager) {
            this.stateManager.updateDisplayOptions({ aircraft3DScale: value });
        }

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
     * Setup unit controls (speed, altitude, vertical speed)
     */
    private setupUnitControls(): void {
        this.bindSelectOption('speed-unit-select', 'speed-unit', 'speedUnit');
        this.bindSelectOption('altitude-unit-select', 'altitude-unit', 'altitudeUnit');
        this.bindSelectOption('vertical-speed-unit-select', 'vertical-speed-unit', 'verticalSpeedUnit');
    }

    /**
     * Setup collapsible sections (Text Sizes, Colors, Units)
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

        const isVisible = section.classList.contains('open');
        const newVisibility = !isVisible;

        this.applyCollapsibleState(sectionId, newVisibility);

        if (newVisibility) {
            // Once the expand animation has finished, make sure the section
            // is visible within the scrollable panel
            window.setTimeout(() => {
                section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }, 240);
        }

        // Save to storage
        storage.set(storageKey, newVisibility);

        // Update state manager
        const update: Partial<DisplayOptions> = {};
        if (storageKey === 'sizes-visible') update.sizesVisible = newVisibility;
        if (storageKey === 'colors-visible') update.colorsVisible = newVisibility;
        if (storageKey === 'units-visible') update.unitsVisible = newVisibility;
        if (storageKey === 'threeD-visible') update.threeDVisible = newVisibility;

        this.stateManager.updateDisplayOptions(update);
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
     * Setup map display options (aircraft, labels, routes, shapes, etc.)
     */
    private setupFutureMapOptions(): void {
        // Master toggles drive their sub-option checkboxes and containers
        this.bindMasterToggle('show-aircraft-labels', 'showAircraftLabels', [
            { id: 'show-aircraft-id', stateKey: 'showAircraftId' },
            { id: 'show-aircraft-speed', stateKey: 'showAircraftSpeed' },
            { id: 'show-aircraft-altitude', stateKey: 'showAircraftAltitude' },
            { id: 'show-aircraft-type', stateKey: 'showAircraftType' }
        ]);
        this.bindMasterToggle('show-shapes', 'showShapes', [
            { id: 'show-shape-fill', stateKey: 'showShapeFill' },
            { id: 'show-shape-lines', stateKey: 'showShapeLines' },
            { id: 'show-shape-labels', stateKey: 'showShapeLabels' }
        ]);
        this.bindMasterToggle('show-airports', 'showAirports', [
            { id: 'show-airport-icons', stateKey: 'showAirportIcons' },
            { id: 'show-airport-labels', stateKey: 'showAirportLabels' },
            { id: 'show-heliports', stateKey: 'showHeliports' },
            { id: 'show-runways', stateKey: 'showRunways' },
            { id: 'show-runway-labels', stateKey: 'showRunwayLabels' },
            { id: 'show-pavement', stateKey: 'showPavement' }
        ]);
        this.bindMasterToggle('show-waypoints', 'showWaypoints', [
            { id: 'show-waypoint-icons', stateKey: 'showWaypointIcons' },
            { id: 'show-waypoint-labels', stateKey: 'showWaypointLabels' }
        ]);

        // Independent boolean options (storage key = element ID)
        const booleanOptions: Array<[string, keyof DisplayOptions]> = [
            ['show-aircraft', 'showAircraft'],
            ['show-aircraft-id', 'showAircraftId'],
            ['show-aircraft-speed', 'showAircraftSpeed'],
            ['show-aircraft-altitude', 'showAircraftAltitude'],
            ['show-aircraft-type', 'showAircraftType'],
            ['show-aircraft-trails', 'showAircraftTrails'],
            ['show-protected-zones', 'showProtectedZones'],
            ['show-shape-fill', 'showShapeFill'],
            ['show-shape-lines', 'showShapeLines'],
            ['show-shape-labels', 'showShapeLabels'],
            ['show-airport-icons', 'showAirportIcons'],
            ['show-airport-labels', 'showAirportLabels'],
            ['show-heliports', 'showHeliports'],
            ['show-waypoint-icons', 'showWaypointIcons'],
            ['show-waypoint-labels', 'showWaypointLabels'],
            ['show-runways', 'showRunways'],
            ['show-runway-labels', 'showRunwayLabels'],
            ['show-pavement', 'showPavement'],
            ['snap-to-navaids', 'snapToNavaids'],
            ['show-search-bar', 'showSearchBar'],
            ['show-routes', 'showRoutes'],
            ['show-route-lines', 'showRouteLines'],
            ['show-route-labels', 'showRouteLabels'],
            ['show-route-points', 'showRoutePoints']
        ];
        for (const [id, stateKey] of booleanOptions) {
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
