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
import { SpeedType, SpeedUnit, AltitudeUnit, VerticalSpeedUnit, AircraftShapeType } from '../../../data/types';
import { logger } from '../../../utils/Logger';

export class DisplayOptionsPanel extends BasePanel {
    private stateManager: StateManager | null = null;

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
        this.setupCollapsibleSections();
        this.setupColorControls();
        this.setupFutureMapOptions();
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
        const speedTypeSelect = document.getElementById('aircraft-speed-type-select') as HTMLSelectElement;
        if (speedTypeSelect) speedTypeSelect.value = speedType;

        const speedUnitSelect = document.getElementById('speed-unit-select') as HTMLSelectElement;
        if (speedUnitSelect) speedUnitSelect.value = speedUnit;

        const altitudeUnitSelect = document.getElementById('altitude-unit-select') as HTMLSelectElement;
        if (altitudeUnitSelect) altitudeUnitSelect.value = altitudeUnit;

        const verticalSpeedUnitSelect = document.getElementById('vertical-speed-unit-select') as HTMLSelectElement;
        if (verticalSpeedUnitSelect) verticalSpeedUnitSelect.value = verticalSpeedUnit;

        const aircraftShapeSelect = document.getElementById('aircraft-shape-select') as HTMLSelectElement;
        if (aircraftShapeSelect) aircraftShapeSelect.value = aircraftShape;

        // Update aircraft icon size UI
        const iconSizeInput = document.getElementById('aircraft-icon-size') as HTMLInputElement;
        if (iconSizeInput) iconSizeInput.value = aircraftIconSize.toString();
        const iconSizeValue = document.getElementById('icon-size-value');
        if (iconSizeValue) iconSizeValue.textContent = aircraftIconSize.toFixed(1);

        // Update map labels text size UI
        const labelsSizeInput = document.getElementById('map-labels-text-size') as HTMLInputElement;
        if (labelsSizeInput) labelsSizeInput.value = mapLabelsTextSize.toString();
        const labelsSizeValue = document.getElementById('labels-size-value');
        if (labelsSizeValue) labelsSizeValue.textContent = mapLabelsTextSize.toString();

        // Update aircraft display checkboxes to reflect loaded values
        const showAircraftCheckbox = document.getElementById('show-aircraft') as HTMLInputElement;
        if (showAircraftCheckbox) showAircraftCheckbox.checked = showAircraft;

        const showAircraftLabelsCheckbox = document.getElementById('show-aircraft-labels') as HTMLInputElement;
        if (showAircraftLabelsCheckbox) showAircraftLabelsCheckbox.checked = showAircraftLabels;

        const showAircraftIdCheckbox = document.getElementById('show-aircraft-id') as HTMLInputElement;
        if (showAircraftIdCheckbox) showAircraftIdCheckbox.checked = showAircraftId;

        const showAircraftSpeedCheckbox = document.getElementById('show-aircraft-speed') as HTMLInputElement;
        if (showAircraftSpeedCheckbox) showAircraftSpeedCheckbox.checked = showAircraftSpeed;

        const showAircraftAltitudeCheckbox = document.getElementById('show-aircraft-altitude') as HTMLInputElement;
        if (showAircraftAltitudeCheckbox) showAircraftAltitudeCheckbox.checked = showAircraftAltitude;

        const showAircraftTypeCheckbox = document.getElementById('show-aircraft-type') as HTMLInputElement;
        if (showAircraftTypeCheckbox) showAircraftTypeCheckbox.checked = showAircraftType;

        const showAircraftTrailsCheckbox = document.getElementById('show-aircraft-trails') as HTMLInputElement;
        if (showAircraftTrailsCheckbox) showAircraftTrailsCheckbox.checked = showAircraftTrails;

        const showProtectedZonesCheckbox = document.getElementById('show-protected-zones') as HTMLInputElement;
        if (showProtectedZonesCheckbox) showProtectedZonesCheckbox.checked = showProtectedZones;

        // Update shape display checkboxes to reflect loaded values
        const showShapesCheckbox = document.getElementById('show-shapes') as HTMLInputElement;
        if (showShapesCheckbox) showShapesCheckbox.checked = showShapes;

        const showShapeFillCheckbox = document.getElementById('show-shape-fill') as HTMLInputElement;
        if (showShapeFillCheckbox) showShapeFillCheckbox.checked = showShapeFill;

        const showShapeLinesCheckbox = document.getElementById('show-shape-lines') as HTMLInputElement;
        if (showShapeLinesCheckbox) showShapeLinesCheckbox.checked = showShapeLines;

        const showShapeLabelsCheckbox = document.getElementById('show-shape-labels') as HTMLInputElement;
        if (showShapeLabelsCheckbox) showShapeLabelsCheckbox.checked = showShapeLabels;

        // Update route display checkboxes to reflect loaded values
        const showRoutesCheckbox = document.getElementById('show-routes') as HTMLInputElement;
        if (showRoutesCheckbox) showRoutesCheckbox.checked = showRoutes;

        const showRouteLinesCheckbox = document.getElementById('show-route-lines') as HTMLInputElement;
        if (showRouteLinesCheckbox) showRouteLinesCheckbox.checked = showRouteLines;

        const showRouteLabelsCheckbox = document.getElementById('show-route-labels') as HTMLInputElement;
        if (showRouteLabelsCheckbox) showRouteLabelsCheckbox.checked = showRouteLabels;

        const showRoutePointsCheckbox = document.getElementById('show-route-points') as HTMLInputElement;
        if (showRoutePointsCheckbox) showRoutePointsCheckbox.checked = showRoutePoints;

        // Update color picker values to reflect loaded colors
        const aircraftIconColorInput = document.getElementById('aircraft-icon-color') as HTMLInputElement;
        if (aircraftIconColorInput) aircraftIconColorInput.value = aircraftIconColor;

        const aircraftLabelsColorInput = document.getElementById('aircraft-labels-color') as HTMLInputElement;
        if (aircraftLabelsColorInput) aircraftLabelsColorInput.value = aircraftLabelColor;

        const aircraftSelectedColorInput = document.getElementById('aircraft-selected-color') as HTMLInputElement;
        if (aircraftSelectedColorInput) aircraftSelectedColorInput.value = aircraftSelectedColor;

        const aircraftConflictColorInput = document.getElementById('aircraft-conflict-color') as HTMLInputElement;
        if (aircraftConflictColorInput) aircraftConflictColorInput.value = aircraftConflictColor;

        const aircraftTrailsColorInput = document.getElementById('aircraft-trails-color') as HTMLInputElement;
        if (aircraftTrailsColorInput) aircraftTrailsColorInput.value = aircraftTrailColor;

        const trailConflictColorInput = document.getElementById('trail-conflict-color') as HTMLInputElement;
        if (trailConflictColorInput) trailConflictColorInput.value = trailConflictColor;

        const protectedZonesColorInput = document.getElementById('protected-zones-color') as HTMLInputElement;
        if (protectedZonesColorInput) protectedZonesColorInput.value = protectedZonesColor;

        const routeLabelsColorInput = document.getElementById('route-labels-color') as HTMLInputElement;
        if (routeLabelsColorInput) routeLabelsColorInput.value = routeLabelsColor;

        const routePointsColorInput = document.getElementById('route-points-color') as HTMLInputElement;
        if (routePointsColorInput) routePointsColorInput.value = routePointsColor;

        const routeLinesColorInput = document.getElementById('route-lines-color') as HTMLInputElement;
        if (routeLinesColorInput) routeLinesColorInput.value = routeLinesColor;

        const shapeFillColorInput = document.getElementById('shape-fill-color') as HTMLInputElement;
        if (shapeFillColorInput) shapeFillColorInput.value = shapeFillColor;

        const shapeLinesColorInput = document.getElementById('shape-lines-color') as HTMLInputElement;
        if (shapeLinesColorInput) shapeLinesColorInput.value = shapeLinesColor;

        const shapeLabelsColorInput = document.getElementById('shape-labels-color') as HTMLInputElement;
        if (shapeLabelsColorInput) shapeLabelsColorInput.value = shapeLabelsColor;

        // Apply collapsible section states
        this.applyCollapsibleState('sizes-controls', sizesVisible);
        this.applyCollapsibleState('colors-controls', colorsVisible);
        this.applyCollapsibleState('units-controls', unitsVisible);
    }

    /**
     * Setup text size controls (header, console & echo, panel)
     */
    private setupTextSizeControls(): void {
        // Header font size
        const headerSizeInput = document.getElementById('header-font-size') as HTMLInputElement;
        if (headerSizeInput) {
            headerSizeInput.addEventListener('input', (e) => {
                const size = parseInt((e.target as HTMLInputElement).value);
                this.updateTextSize('header', size);
            });
        }

        // Console & Echo font size (single control for both)
        const consoleSizeInput = document.getElementById('console-font-size') as HTMLInputElement;
        if (consoleSizeInput) {
            consoleSizeInput.addEventListener('input', (e) => {
                const size = parseInt((e.target as HTMLInputElement).value);
                this.updateTextSize('console', size);
                // Also apply to echo since they now share the same size
                this.applyTextSize('echo', size);
            });
        }

        // Panel font size
        const panelSizeInput = document.getElementById('panel-font-size') as HTMLInputElement;
        if (panelSizeInput) {
            panelSizeInput.addEventListener('input', (e) => {
                const size = parseInt((e.target as HTMLInputElement).value);
                this.updateTextSize('panel', size);
            });
        }
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

        // Update state manager
        const updateKey = `${type}FontSize` as keyof typeof update;
        const update: any = {};
        update[updateKey] = size;
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
        const input = document.getElementById(inputId) as HTMLInputElement;
        if (input) input.value = size.toString();

        const valueSpan = document.getElementById(valueId);
        if (valueSpan) valueSpan.textContent = size.toString();
    }

    /**
     * Setup speed type control (CAS/TAS/GS)
     */
    private setupSpeedTypeControl(): void {
        const speedTypeSelect = document.getElementById('aircraft-speed-type-select') as HTMLSelectElement;
        if (!speedTypeSelect) return;

        speedTypeSelect.addEventListener('change', (e) => {
            const speedType = (e.target as HTMLSelectElement).value as SpeedType;

            if (this.stateManager) {
                this.stateManager.updateDisplayOptions({ speedType });
                storage.set('speed-type', speedType);
            }
        });
    }

    /**
     * Setup aircraft shape control
     */
    private setupAircraftShapeControl(): void {
        const aircraftShapeSelect = document.getElementById('aircraft-shape-select') as HTMLSelectElement;
        if (!aircraftShapeSelect) return;

        aircraftShapeSelect.addEventListener('change', (e) => {
            const aircraftShape = (e.target as HTMLSelectElement).value as AircraftShapeType;

            if (this.stateManager) {
                this.stateManager.updateDisplayOptions({ aircraftShape });
                storage.set('aircraft-shape', aircraftShape);
            }
        });
    }

    /**
     * Setup unit controls (speed, altitude, vertical speed)
     */
    private setupUnitControls(): void {
        // Speed unit
        const speedUnitSelect = document.getElementById('speed-unit-select') as HTMLSelectElement;
        if (speedUnitSelect) {
            speedUnitSelect.addEventListener('change', (e) => {
                const speedUnit = (e.target as HTMLSelectElement).value as SpeedUnit;
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ speedUnit });
                    storage.set('speed-unit', speedUnit);
                }
            });
        }

        // Altitude unit
        const altitudeUnitSelect = document.getElementById('altitude-unit-select') as HTMLSelectElement;
        if (altitudeUnitSelect) {
            altitudeUnitSelect.addEventListener('change', (e) => {
                const altitudeUnit = (e.target as HTMLSelectElement).value as AltitudeUnit;
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ altitudeUnit });
                    storage.set('altitude-unit', altitudeUnit);
                }
            });
        }

        // Vertical speed unit
        const verticalSpeedUnitSelect = document.getElementById('vertical-speed-unit-select') as HTMLSelectElement;
        if (verticalSpeedUnitSelect) {
            verticalSpeedUnitSelect.addEventListener('change', (e) => {
                const verticalSpeedUnit = (e.target as HTMLSelectElement).value as VerticalSpeedUnit;
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ verticalSpeedUnit });
                    storage.set('vertical-speed-unit', verticalSpeedUnit);
                }
            });
        }
    }

    /**
     * Setup collapsible sections (Text Sizes, Colors, Units)
     */
    private setupCollapsibleSections(): void {
        // Text Sizes toggle
        const sizesToggle = document.getElementById('sizes-toggle');
        if (sizesToggle) {
            sizesToggle.addEventListener('click', () => {
                this.toggleCollapsibleSection('sizes-controls', 'sizes-visible');
            });
        }

        // Colors toggle
        const colorsToggle = document.getElementById('colors-toggle');
        if (colorsToggle) {
            colorsToggle.addEventListener('click', () => {
                this.toggleCollapsibleSection('colors-controls', 'colors-visible');
            });
        }

        // Units toggle
        const unitsToggle = document.getElementById('units-toggle');
        if (unitsToggle) {
            unitsToggle.addEventListener('click', () => {
                this.toggleCollapsibleSection('units-controls', 'units-visible');
            });
        }
    }

    /**
     * Toggle a collapsible section
     */
    private toggleCollapsibleSection(sectionId: string, storageKey: string): void {
        const section = document.getElementById(sectionId);
        if (!section || !this.stateManager) return;

        const isVisible = section.style.display === 'block';
        const newVisibility = !isVisible;

        this.applyCollapsibleState(sectionId, newVisibility);

        // Save to storage
        storage.set(storageKey, newVisibility);

        // Update state manager
        const update: any = {};
        if (storageKey === 'sizes-visible') update.sizesVisible = newVisibility;
        if (storageKey === 'colors-visible') update.colorsVisible = newVisibility;
        if (storageKey === 'units-visible') update.unitsVisible = newVisibility;

        this.stateManager.updateDisplayOptions(update);
    }

    /**
     * Apply collapsible section state
     */
    private applyCollapsibleState(sectionId: string, isVisible: boolean): void {
        const section = document.getElementById(sectionId);
        if (section) {
            section.style.display = isVisible ? 'block' : 'none';
        }
    }

    /**
     * Setup color controls
     */
    private setupColorControls(): void {
        // Helper function to setup a color input
        const setupColorInput = (inputId: string, storageKey: string, stateKey: string) => {
            const input = document.getElementById(inputId) as HTMLInputElement;
            if (input) {
                input.addEventListener('input', (e) => {
                    const color = (e.target as HTMLInputElement).value;

                    // Save to storage
                    storage.set(storageKey, color);

                    // Update state manager
                    if (this.stateManager) {
                        const update: any = {};
                        update[stateKey] = color;
                        this.stateManager.updateDisplayOptions(update);
                    }
                });
            }
        };

        // Setup all color inputs
        setupColorInput('aircraft-icon-color', 'aircraft-icon-color', 'aircraftIconColor');
        setupColorInput('aircraft-labels-color', 'aircraft-labels-color', 'aircraftLabelColor');
        setupColorInput('aircraft-selected-color', 'aircraft-selected-color', 'aircraftSelectedColor');
        setupColorInput('aircraft-conflict-color', 'aircraft-conflict-color', 'aircraftConflictColor');
        setupColorInput('aircraft-trails-color', 'aircraft-trails-color', 'aircraftTrailColor');
        setupColorInput('trail-conflict-color', 'trail-conflict-color', 'trailConflictColor');
        setupColorInput('protected-zones-color', 'protected-zones-color', 'protectedZonesColor');
        setupColorInput('route-labels-color', 'route-labels-color', 'routeLabelsColor');
        setupColorInput('route-points-color', 'route-points-color', 'routePointsColor');
        setupColorInput('route-lines-color', 'route-lines-color', 'routeLinesColor');
        setupColorInput('shape-fill-color', 'shape-fill-color', 'shapeFillColor');
        setupColorInput('shape-lines-color', 'shape-lines-color', 'shapeLinesColor');
        setupColorInput('shape-labels-color', 'shape-labels-color', 'shapeLabelsColor');

        // Setup reset to defaults button
        const resetColorsBtn = document.getElementById('reset-colors-btn');
        if (resetColorsBtn) {
            resetColorsBtn.addEventListener('click', () => {
                this.resetColorsToDefaults();
            });
        }
    }

    /**
     * Reset all colors to default values
     */
    private resetColorsToDefaults(): void {
        if (!this.stateManager) return;

        // Default colors (matching StateManager defaults)
        const defaultColors = {
            aircraftIconColor: '#00ff00',
            aircraftLabelColor: '#0066cc',
            aircraftSelectedColor: '#ff6600',
            aircraftConflictColor: '#ffa000',
            aircraftTrailColor: '#0066cc',
            trailConflictColor: '#ffa000',
            protectedZonesColor: '#00ff00',
            routeLabelsColor: '#ff00ff',
            routePointsColor: '#ff00ff',
            routeLinesColor: '#ff00ff',
            shapeFillColor: '#ff00ff',
            shapeLinesColor: '#ff00ff',
            shapeLabelsColor: '#ff00ff'
        };

        // Update storage with defaults
        storage.set('aircraft-icon-color', defaultColors.aircraftIconColor);
        storage.set('aircraft-labels-color', defaultColors.aircraftLabelColor);
        storage.set('aircraft-selected-color', defaultColors.aircraftSelectedColor);
        storage.set('aircraft-conflict-color', defaultColors.aircraftConflictColor);
        storage.set('aircraft-trails-color', defaultColors.aircraftTrailColor);
        storage.set('trail-conflict-color', defaultColors.trailConflictColor);
        storage.set('protected-zones-color', defaultColors.protectedZonesColor);
        storage.set('route-labels-color', defaultColors.routeLabelsColor);
        storage.set('route-points-color', defaultColors.routePointsColor);
        storage.set('route-lines-color', defaultColors.routeLinesColor);
        storage.set('shape-fill-color', defaultColors.shapeFillColor);
        storage.set('shape-lines-color', defaultColors.shapeLinesColor);
        storage.set('shape-labels-color', defaultColors.shapeLabelsColor);

        // Update state manager
        this.stateManager.updateDisplayOptions(defaultColors);

        // Update UI color pickers
        const aircraftIconColorInput = document.getElementById('aircraft-icon-color') as HTMLInputElement;
        if (aircraftIconColorInput) aircraftIconColorInput.value = defaultColors.aircraftIconColor;

        const aircraftLabelsColorInput = document.getElementById('aircraft-labels-color') as HTMLInputElement;
        if (aircraftLabelsColorInput) aircraftLabelsColorInput.value = defaultColors.aircraftLabelColor;

        const aircraftSelectedColorInput = document.getElementById('aircraft-selected-color') as HTMLInputElement;
        if (aircraftSelectedColorInput) aircraftSelectedColorInput.value = defaultColors.aircraftSelectedColor;

        const aircraftConflictColorInput = document.getElementById('aircraft-conflict-color') as HTMLInputElement;
        if (aircraftConflictColorInput) aircraftConflictColorInput.value = defaultColors.aircraftConflictColor;

        const aircraftTrailsColorInput = document.getElementById('aircraft-trails-color') as HTMLInputElement;
        if (aircraftTrailsColorInput) aircraftTrailsColorInput.value = defaultColors.aircraftTrailColor;

        const trailConflictColorInput = document.getElementById('trail-conflict-color') as HTMLInputElement;
        if (trailConflictColorInput) trailConflictColorInput.value = defaultColors.trailConflictColor;

        const protectedZonesColorInput = document.getElementById('protected-zones-color') as HTMLInputElement;
        if (protectedZonesColorInput) protectedZonesColorInput.value = defaultColors.protectedZonesColor;

        const routeLabelsColorInput = document.getElementById('route-labels-color') as HTMLInputElement;
        if (routeLabelsColorInput) routeLabelsColorInput.value = defaultColors.routeLabelsColor;

        const routePointsColorInput = document.getElementById('route-points-color') as HTMLInputElement;
        if (routePointsColorInput) routePointsColorInput.value = defaultColors.routePointsColor;

        const routeLinesColorInput = document.getElementById('route-lines-color') as HTMLInputElement;
        if (routeLinesColorInput) routeLinesColorInput.value = defaultColors.routeLinesColor;

        const shapeFillColorInput = document.getElementById('shape-fill-color') as HTMLInputElement;
        if (shapeFillColorInput) shapeFillColorInput.value = defaultColors.shapeFillColor;

        const shapeLinesColorInput = document.getElementById('shape-lines-color') as HTMLInputElement;
        if (shapeLinesColorInput) shapeLinesColorInput.value = defaultColors.shapeLinesColor;

        const shapeLabelsColorInput = document.getElementById('shape-labels-color') as HTMLInputElement;
        if (shapeLabelsColorInput) shapeLabelsColorInput.value = defaultColors.shapeLabelsColor;

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
        // Setup listeners to save values and update state manager

        // Aircraft icon visibility
        const showAircraftCheckbox = document.getElementById('show-aircraft') as HTMLInputElement;
        if (showAircraftCheckbox) {
            showAircraftCheckbox.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                storage.set('show-aircraft', checked);
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ showAircraft: checked });
                }
            });
        }

        // Aircraft labels visibility - acts as global toggle for ID, Speed, and Altitude
        const showAircraftLabelsCheckbox = document.getElementById('show-aircraft-labels') as HTMLInputElement;
        if (showAircraftLabelsCheckbox) {
            showAircraftLabelsCheckbox.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;

                // Save the main labels toggle state
                storage.set('show-aircraft-labels', checked);

                // Update all four label sub-options to match
                storage.set('show-aircraft-id', checked);
                storage.set('show-aircraft-speed', checked);
                storage.set('show-aircraft-altitude', checked);
                storage.set('show-aircraft-type', checked);

                // Update the UI checkboxes for ID, Speed, Altitude, and Type
                const showAircraftIdCheckbox = document.getElementById('show-aircraft-id') as HTMLInputElement;
                if (showAircraftIdCheckbox) showAircraftIdCheckbox.checked = checked;

                const showAircraftSpeedCheckbox = document.getElementById('show-aircraft-speed') as HTMLInputElement;
                if (showAircraftSpeedCheckbox) showAircraftSpeedCheckbox.checked = checked;

                const showAircraftAltitudeCheckbox = document.getElementById('show-aircraft-altitude') as HTMLInputElement;
                if (showAircraftAltitudeCheckbox) showAircraftAltitudeCheckbox.checked = checked;

                const showAircraftTypeCheckbox = document.getElementById('show-aircraft-type') as HTMLInputElement;
                if (showAircraftTypeCheckbox) showAircraftTypeCheckbox.checked = checked;

                // Toggle visibility of sub-option containers
                this.toggleSubOptionContainers([
                    'show-aircraft-id-container',
                    'show-aircraft-speed-container',
                    'show-aircraft-altitude-container',
                    'show-aircraft-type-container'
                ], checked);

                // Update state manager with all five values
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({
                        showAircraftLabels: checked,
                        showAircraftId: checked,
                        showAircraftSpeed: checked,
                        showAircraftAltitude: checked,
                        showAircraftType: checked
                    });
                }
            });
        }

        // Aircraft ID visibility
        const showAircraftIdCheckbox = document.getElementById('show-aircraft-id') as HTMLInputElement;
        if (showAircraftIdCheckbox) {
            showAircraftIdCheckbox.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                storage.set('show-aircraft-id', checked);
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ showAircraftId: checked });
                }
            });
        }

        // Aircraft speed visibility
        const showAircraftSpeedCheckbox = document.getElementById('show-aircraft-speed') as HTMLInputElement;
        if (showAircraftSpeedCheckbox) {
            showAircraftSpeedCheckbox.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                storage.set('show-aircraft-speed', checked);
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ showAircraftSpeed: checked });
                }
            });
        }

        // Aircraft altitude visibility
        const showAircraftAltitudeCheckbox = document.getElementById('show-aircraft-altitude') as HTMLInputElement;
        if (showAircraftAltitudeCheckbox) {
            showAircraftAltitudeCheckbox.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                storage.set('show-aircraft-altitude', checked);
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ showAircraftAltitude: checked });
                }
            });
        }

        // Aircraft type visibility
        const showAircraftTypeCheckbox = document.getElementById('show-aircraft-type') as HTMLInputElement;
        if (showAircraftTypeCheckbox) {
            showAircraftTypeCheckbox.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                storage.set('show-aircraft-type', checked);
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ showAircraftType: checked });
                }
            });
        }

        // Shape display options - master toggle controls all sub-options
        const showShapesCheckbox = document.getElementById('show-shapes') as HTMLInputElement;
        if (showShapesCheckbox) {
            showShapesCheckbox.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;

                // Save the main shapes toggle state
                storage.set('show-shapes', checked);

                // Update all three shape sub-options to match
                storage.set('show-shape-fill', checked);
                storage.set('show-shape-lines', checked);
                storage.set('show-shape-labels', checked);

                // Update the UI checkboxes for Fill, Lines, and Labels
                const showShapeFillCheckbox = document.getElementById('show-shape-fill') as HTMLInputElement;
                if (showShapeFillCheckbox) showShapeFillCheckbox.checked = checked;

                const showShapeLinesCheckbox = document.getElementById('show-shape-lines') as HTMLInputElement;
                if (showShapeLinesCheckbox) showShapeLinesCheckbox.checked = checked;

                const showShapeLabelsCheckbox = document.getElementById('show-shape-labels') as HTMLInputElement;
                if (showShapeLabelsCheckbox) showShapeLabelsCheckbox.checked = checked;

                // Toggle visibility of sub-option containers
                this.toggleSubOptionContainers([
                    'show-shape-fill-container',
                    'show-shape-lines-container',
                    'show-shape-labels-container'
                ], checked);

                // Update state manager with all four values
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({
                        showShapes: checked,
                        showShapeFill: checked,
                        showShapeLines: checked,
                        showShapeLabels: checked
                    });
                }
            });
        }

        const showShapeFillCheckbox = document.getElementById('show-shape-fill') as HTMLInputElement;
        if (showShapeFillCheckbox) {
            showShapeFillCheckbox.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                storage.set('show-shape-fill', checked);
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ showShapeFill: checked });
                }
            });
        }

        const showShapeLinesCheckbox = document.getElementById('show-shape-lines') as HTMLInputElement;
        if (showShapeLinesCheckbox) {
            showShapeLinesCheckbox.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                storage.set('show-shape-lines', checked);
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ showShapeLines: checked });
                }
            });
        }

        const showShapeLabelsCheckbox = document.getElementById('show-shape-labels') as HTMLInputElement;
        if (showShapeLabelsCheckbox) {
            showShapeLabelsCheckbox.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                storage.set('show-shape-labels', checked);
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ showShapeLabels: checked });
                }
            });
        }

        // Route display options
        const showRoutesCheckbox = document.getElementById('show-routes') as HTMLInputElement;
        if (showRoutesCheckbox) {
            showRoutesCheckbox.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                storage.set('show-routes', checked);
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ showRoutes: checked });
                }
            });
        }

        const showRouteLinesCheckbox = document.getElementById('show-route-lines') as HTMLInputElement;
        if (showRouteLinesCheckbox) {
            showRouteLinesCheckbox.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                storage.set('show-route-lines', checked);
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ showRouteLines: checked });
                }
            });
        }

        const showRouteLabelsCheckbox = document.getElementById('show-route-labels') as HTMLInputElement;
        if (showRouteLabelsCheckbox) {
            showRouteLabelsCheckbox.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                storage.set('show-route-labels', checked);
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ showRouteLabels: checked });
                }
            });
        }

        const showRoutePointsCheckbox = document.getElementById('show-route-points') as HTMLInputElement;
        if (showRoutePointsCheckbox) {
            showRoutePointsCheckbox.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                storage.set('show-route-points', checked);
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ showRoutePoints: checked });
                }
            });
        }

        // Protected Zones toggle
        const showProtectedZonesCheckbox = document.getElementById('show-protected-zones') as HTMLInputElement;
        if (showProtectedZonesCheckbox) {
            showProtectedZonesCheckbox.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                storage.set('show-protected-zones', checked);
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ showProtectedZones: checked });
                }
            });
        }

        // Aircraft Trails toggle
        const showAircraftTrailsCheckbox = document.getElementById('show-aircraft-trails') as HTMLInputElement;
        if (showAircraftTrailsCheckbox) {
            showAircraftTrailsCheckbox.addEventListener('change', (e) => {
                const checked = (e.target as HTMLInputElement).checked;
                storage.set('show-aircraft-trails', checked);
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ showAircraftTrails: checked });
                }
            });
        }

        // Aircraft icon size
        const iconSizeInput = document.getElementById('aircraft-icon-size') as HTMLInputElement;
        if (iconSizeInput) {
            iconSizeInput.addEventListener('input', (e) => {
                const size = parseFloat((e.target as HTMLInputElement).value);
                const valueSpan = document.getElementById('icon-size-value');
                if (valueSpan) valueSpan.textContent = size.toFixed(1);
                storage.set('aircraft-icon-size', size);

                // Update state manager to notify all components
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ aircraftIconSize: size });
                }
            });
        }

        // Map labels text size
        const labelsSizeInput = document.getElementById('map-labels-text-size') as HTMLInputElement;
        if (labelsSizeInput) {
            labelsSizeInput.addEventListener('input', (e) => {
                const size = parseInt((e.target as HTMLInputElement).value);
                const valueSpan = document.getElementById('labels-size-value');
                if (valueSpan) valueSpan.textContent = size.toString();
                storage.set('map-labels-text-size', size);

                // Update state manager to notify all components
                if (this.stateManager) {
                    this.stateManager.updateDisplayOptions({ mapLabelsTextSize: size });
                }
            });
        }
    }

    public update(data?: any): void {
        // No periodic updates needed for this panel
    }
}
