import { MapDisplay } from '../MapDisplay';
import { modalManager } from '../../ModalManager';
import { Map as MapLibreMap } from 'maplibre-gl';
import { SpeedUnit, AltitudeUnit } from '../../../data/types';
import { OPENAP_AIRCRAFT_TYPES, isOpenapAircraftType } from '../../../data/aircraftTypes';
import type { App } from '../../../core/App';
import type { NavaidSnapper } from '../NavaidSnapper';
import { logger } from '../../../utils/Logger';

/**
 * AircraftCreationManager - Manages aircraft creation functionality
 *
 * Handles:
 * - Manual aircraft creation (with lat/lon/heading input)
 * - Map-based aircraft creation (click position and heading)
 * - Form validation
 * - CRE command generation
 * - Unit conversion (always sends to BlueSky in feet and knots)
 */
interface AircraftData {
    id: string;
    actype: string; // Aircraft type
    altDisplay: number;
    altUnit: AltitudeUnit;
    spdDisplay: number;
    spdUnit: SpeedUnit;
}

interface AppWindow extends Window {
    app?: App;
}

declare const window: AppWindow;

export class AircraftCreationManager {
    private mapDisplay: MapDisplay;
    private navaidSnapper: NavaidSnapper;
    private creationMode: 'manual' | 'map' = 'manual';
    private aircraftDrawingMode: boolean = false;
    private aircraftDrawingPoints: [number, number][] = [];
    private currentAircraftData: AircraftData | null = null;
    private aircraftPosition: [number, number] | null = null;

    // Event handlers - stored as references for proper cleanup
    private aircraftMapClickHandler: ((e: any) => void) | null = null;
    private aircraftMouseMoveHandler: ((e: any) => void) | null = null;
    private aircraftSnapHoverHandler: ((e: any) => void) | null = null;
    private aircraftEscapeHandler: ((e: KeyboardEvent) => void) | null = null;

    // Aircraft type dropdown state (for the Create Aircraft modal)
    private typeDropdownSuggestions: string[] = [];
    private typeDropdownSelectedIndex: number = -1;

    constructor(mapDisplay: MapDisplay, navaidSnapper: NavaidSnapper) {
        this.mapDisplay = mapDisplay;
        this.navaidSnapper = navaidSnapper;
        this.setupModalHandlers();
    }

    /**
     * Convert altitude from any unit to feet (for BlueSky commands)
     */
    private convertAltitudeToFeet(value: number, fromUnit: AltitudeUnit): number {
        if (isNaN(value)) return NaN;

        switch (fromUnit) {
            case 'm':
                return Math.round(value * 3.28084); // meters to feet
            case 'km':
                return Math.round(value * 3280.84); // kilometers to feet
            case 'fl':
                return Math.round(value * 100); // flight level to feet
            case 'ft':
            default:
                return Math.round(value); // already in feet
        }
    }

    /**
     * Convert speed from any unit to knots (for BlueSky commands)
     */
    private convertSpeedToKnots(value: number, fromUnit: SpeedUnit): number {
        if (isNaN(value)) return NaN;

        switch (fromUnit) {
            case 'm/s':
                return Math.round(value * 1.94384); // m/s to knots
            case 'km/h':
                return Math.round(value * 0.539957); // km/h to knots
            case 'mph':
                return Math.round(value * 0.868976); // mph to knots
            case 'knots':
            default:
                return Math.round(value); // already in knots
        }
    }

    /**
     * Get current altitude unit from UI
     */
    private getCurrentAltitudeUnit(): AltitudeUnit {
        const altitudeUnitSelect = document.getElementById('altitude-unit-select') as HTMLSelectElement;
        return (altitudeUnitSelect?.value as AltitudeUnit) || 'ft';
    }

    /**
     * Get current speed unit from UI
     */
    private getCurrentSpeedUnit(): SpeedUnit {
        const speedUnitSelect = document.getElementById('speed-unit-select') as HTMLSelectElement;
        return (speedUnitSelect?.value as SpeedUnit) || 'knots';
    }

    /**
     * Set up modal event handlers
     */
    private setupModalHandlers(): void {
        // Handle Create Aircraft submit button
        const submitBtn = document.getElementById('create-aircraft-submit');
        if (submitBtn) {
            submitBtn.addEventListener('click', () => {
                this.onSubmitClick();
            });
        }

        // Handle Start Drawing button (for map mode)
        const startDrawingBtn = document.getElementById('start-aircraft-drawing');
        if (startDrawingBtn) {
            startDrawingBtn.addEventListener('click', () => {
                this.onStartDrawingClick();
            });
        }

        // Handle creation mode changes
        const modeSelect = document.getElementById('aircraft-creation-mode') as HTMLSelectElement;
        if (modeSelect) {
            modeSelect.addEventListener('change', () => {
                this.updateCreationMode();
            });
        }

        // Set up real-time duplicate-ID warning for aircraft ID.
        // NOTE: this is non-blocking — it only warns, submission is still
        // allowed so the user can intentionally send a duplicate CRE and
        // let BlueSky respond with its own error.
        const idInput = document.getElementById('aircraft-id-input') as HTMLInputElement;
        if (idInput) {
            idInput.addEventListener('input', () => {
                this.updateAircraftIdWarning();
            });
            idInput.addEventListener('blur', () => {
                this.updateAircraftIdWarning();
            });
        }

        // Set up the aircraft type autocomplete dropdown + openap warning
        this.setupAircraftTypeAutocomplete();

        // Handle Enter key in input fields
        const inputIds = [
            'aircraft-id-input',
            'aircraft-type-input',
            'aircraft-lat-input',
            'aircraft-lon-input',
            'aircraft-hdg-input',
            'aircraft-alt-input',
            'aircraft-spd-input'
        ];

        inputIds.forEach(inputId => {
            const input = document.getElementById(inputId);
            if (input) {
                input.addEventListener('keypress', (e) => {
                    if (e instanceof KeyboardEvent && e.key === 'Enter') {
                        this.onSubmitClick();
                    }
                });
            }
        });
    }

    /**
     * Show the aircraft creation modal
     */
    public showModal(): void {
        const modal = modalManager.open('create-aircraft-modal');
        if (modal) {
            // Update creation mode UI
            this.updateCreationMode();

            // Update unit labels to match current display settings
            this.updateUnitLabels();

            logger.debug('AircraftCreationManager', 'Showing aircraft creation modal');
        }
    }

    /**
     * Update unit labels in the modal to match current display settings
     */
    private updateUnitLabels(): void {
        const currentAltUnit = this.getCurrentAltitudeUnit();
        const currentSpeedUnit = this.getCurrentSpeedUnit();

        // Update altitude label and placeholder
        const altLabel = document.getElementById('aircraft-alt-label');
        const altInput = document.getElementById('aircraft-alt-input') as HTMLInputElement;
        if (altLabel && altInput) {
            let unitLabel = '';
            let placeholder = '';

            switch (currentAltUnit) {
                case 'm':
                    unitLabel = 'Altitude (m)';
                    placeholder = 'e.g. 3048';
                    break;
                case 'km':
                    unitLabel = 'Altitude (km)';
                    placeholder = 'e.g. 3.0';
                    break;
                case 'fl':
                    unitLabel = 'Flight Level (FL)';
                    placeholder = 'e.g. 100 (for FL100)';
                    break;
                case 'ft':
                default:
                    unitLabel = 'Altitude (ft)';
                    placeholder = 'e.g. 10000';
                    break;
            }

            altLabel.textContent = `${unitLabel}:`;
            altInput.placeholder = placeholder;
        }

        // Update speed label
        const spdLabel = document.getElementById('aircraft-spd-label');
        if (spdLabel) {
            let spdUnitText = '';
            switch (currentSpeedUnit) {
                case 'm/s': spdUnitText = '(m/s)'; break;
                case 'km/h': spdUnitText = '(km/h)'; break;
                case 'mph': spdUnitText = '(mph)'; break;
                case 'knots': spdUnitText = '(knots)'; break;
            }
            spdLabel.textContent = `Calibrated Airspeed ${spdUnitText}:`;
        }

        // Update help text
        const altHelp = document.getElementById('aircraft-alt-help');
        if (altHelp) {
            altHelp.textContent = `Initial altitude in ${currentAltUnit}`;
        }

        const spdHelp = document.getElementById('aircraft-spd-help');
        if (spdHelp) {
            spdHelp.textContent = `Initial speed in ${currentSpeedUnit}`;
        }

        logger.debug('AircraftCreationManager', `Updated unit labels: altitude=${currentAltUnit}, speed=${currentSpeedUnit}`);
    }

    /**
     * Close the aircraft creation modal
     */
    private closeModal(): void {
        modalManager.close('create-aircraft-modal');

        // Clear form fields
        const inputIds = [
            'aircraft-id-input',
            'aircraft-type-input',
            'aircraft-lat-input',
            'aircraft-lon-input',
            'aircraft-hdg-input',
            'aircraft-alt-input',
            'aircraft-spd-input'
        ];

        inputIds.forEach(inputId => {
            const input = document.getElementById(inputId) as HTMLInputElement;
            if (input) input.value = '';
        });

        // Clear any pending warnings
        this.hideAircraftIdWarning();

        // Clear type dropdown + warning
        this.hideAircraftTypeDropdown();
        const typeWarning = document.getElementById('aircraft-type-warning');
        if (typeWarning) typeWarning.style.display = 'none';

        // Reset to manual mode
        const modeSelect = document.getElementById('aircraft-creation-mode') as HTMLSelectElement;
        if (modeSelect) modeSelect.value = 'manual';

        logger.debug('AircraftCreationManager', 'Closed aircraft creation modal');
    }

    /**
     * Update creation mode UI
     */
    private updateCreationMode(): void {
        const modeSelect = document.getElementById('aircraft-creation-mode') as HTMLSelectElement;
        const mode = modeSelect?.value || 'manual';
        this.creationMode = mode as 'manual' | 'map';

        const manualFields = document.getElementById('manual-position-fields');
        const mapInstructions = document.getElementById('map-drawing-instruction');
        const submitBtn = document.getElementById('create-aircraft-submit');
        const startDrawingBtn = document.getElementById('start-aircraft-drawing');

        if (mode === 'manual') {
            if (manualFields) manualFields.style.display = 'block';
            if (mapInstructions) mapInstructions.style.display = 'none';
            if (submitBtn) submitBtn.style.display = 'inline-block';
            if (startDrawingBtn) startDrawingBtn.style.display = 'none';
        } else {
            if (manualFields) manualFields.style.display = 'none';
            if (mapInstructions) mapInstructions.style.display = 'block';
            if (submitBtn) submitBtn.style.display = 'none';
            if (startDrawingBtn) startDrawingBtn.style.display = 'inline-block';
        }
    }

    /**
     * Handle submit button click
     */
    private onSubmitClick(): void {
        if (this.creationMode === 'manual') {
            this.createAircraftManual();
        }
    }

    /**
     * Handle start drawing button click (map mode)
     */
    private onStartDrawingClick(): void {
        logger.debug('AircraftCreationManager', 'Start drawing aircraft on map');

        // Get input values for aircraft data
        const idInput = document.getElementById('aircraft-id-input') as HTMLInputElement;
        const typeInput = document.getElementById('aircraft-type-input') as HTMLInputElement;
        const altInput = document.getElementById('aircraft-alt-input') as HTMLInputElement;
        const spdInput = document.getElementById('aircraft-spd-input') as HTMLInputElement;

        const id = idInput?.value.trim();
        const type = typeInput?.value.trim();
        const alt = altInput?.value;
        const spd = spdInput?.value;

        // Validate required fields
        if (!id) {
            alert('Please enter an aircraft ID');
            idInput?.focus();
            return;
        }

        // Duplicate-ID check is advisory only (non-blocking). Refresh the
        // warning so it reflects the latest value, then continue.
        this.updateAircraftIdWarning();

        if (!type) {
            alert('Please enter an aircraft type');
            typeInput?.focus();
            return;
        }

        if (!alt || !spd) {
            alert('Please enter altitude and speed');
            return;
        }

        // Store aircraft data for later use with current unit selections
        const currentAltUnit = this.getCurrentAltitudeUnit();
        const currentSpeedUnit = this.getCurrentSpeedUnit();

        this.currentAircraftData = {
            id: id,
            actype: type,
            altDisplay: parseFloat(alt),
            altUnit: currentAltUnit,
            spdDisplay: parseFloat(spd),
            spdUnit: currentSpeedUnit
        };

        // Start aircraft drawing mode
        this.aircraftDrawingMode = true;
        this.aircraftDrawingPoints = [];

        logger.debug('AircraftCreationManager', 'Aircraft drawing mode set to:', this.aircraftDrawingMode);
        logger.debug('AircraftCreationManager', 'About to close modal and enable map drawing');

        // Close modal (but don't stop drawing) and enable map drawing
        this.closeModal();
        this.enableAircraftMapDrawing();

        logger.debug('AircraftCreationManager', 'Started aircraft drawing mode');
    }

    /**
     * Set up autocomplete dropdown + openap warning for the aircraft type input
     */
    private setupAircraftTypeAutocomplete(): void {
        const typeInput = document.getElementById('aircraft-type-input') as HTMLInputElement;
        const dropdown = document.getElementById('aircraft-type-dropdown') as HTMLDivElement;
        if (!typeInput || !dropdown) return;

        // Filter + show dropdown and warning as user types
        typeInput.addEventListener('input', () => {
            this.updateAircraftTypeDropdown();
            this.updateAircraftTypeWarning();
        });

        // Show all types on focus when the field is empty
        typeInput.addEventListener('focus', () => {
            this.updateAircraftTypeDropdown();
        });

        // Keyboard navigation - must run on keydown so preventDefault here
        // also cancels the Enter-as-submit keypress handler registered below.
        typeInput.addEventListener('keydown', (e: KeyboardEvent) => {
            const visible = dropdown.style.display !== 'none';
            if (!visible) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.typeDropdownSelectedIndex = Math.min(
                    this.typeDropdownSelectedIndex + 1,
                    this.typeDropdownSuggestions.length - 1
                );
                this.renderAircraftTypeDropdown();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.typeDropdownSelectedIndex = Math.max(
                    this.typeDropdownSelectedIndex - 1,
                    -1
                );
                this.renderAircraftTypeDropdown();
            } else if (e.key === 'Enter' || e.key === 'Tab') {
                if (this.typeDropdownSelectedIndex >= 0) {
                    e.preventDefault();
                    this.selectAircraftTypeSuggestion(this.typeDropdownSelectedIndex);
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.hideAircraftTypeDropdown();
            }
        });

        // Hide dropdown on blur (with a small delay so mousedown selection fires)
        typeInput.addEventListener('blur', () => {
            setTimeout(() => {
                this.hideAircraftTypeDropdown();
                this.updateAircraftTypeWarning();
            }, 150);
        });
    }

    /**
     * Refresh the aircraft type dropdown with the current filter value
     */
    private updateAircraftTypeDropdown(): void {
        const typeInput = document.getElementById('aircraft-type-input') as HTMLInputElement;
        if (!typeInput) return;

        const upperPartial = typeInput.value.trim().toUpperCase();

        // Empty partial -> show the entire list (scrollable)
        let filtered: string[];
        if (upperPartial.length === 0) {
            filtered = [...OPENAP_AIRCRAFT_TYPES];
        } else {
            const startsWith = OPENAP_AIRCRAFT_TYPES.filter(t =>
                t.startsWith(upperPartial)
            );
            const contains = OPENAP_AIRCRAFT_TYPES.filter(t =>
                !t.startsWith(upperPartial) && t.includes(upperPartial)
            );
            filtered = [...startsWith, ...contains];
        }

        // If the user typed an exact openap type (the only match), hide the
        // dropdown; nothing more to pick.
        if (filtered.length === 1 && filtered[0] === upperPartial) {
            this.hideAircraftTypeDropdown();
            return;
        }

        // If the partial matches nothing in the openap list, hide the
        // dropdown so the user can keep typing a custom type freely.
        if (filtered.length === 0) {
            this.hideAircraftTypeDropdown();
            return;
        }

        this.typeDropdownSuggestions = filtered;
        if (this.typeDropdownSelectedIndex >= filtered.length) {
            this.typeDropdownSelectedIndex = -1;
        }
        this.renderAircraftTypeDropdown();
    }

    /**
     * Render the aircraft type dropdown DOM
     */
    private renderAircraftTypeDropdown(): void {
        const dropdown = document.getElementById('aircraft-type-dropdown') as HTMLDivElement;
        if (!dropdown) return;

        dropdown.innerHTML = '';

        this.typeDropdownSuggestions.forEach((type, index) => {
            const item = document.createElement('div');
            item.className = 'modal-actype-dropdown-item';
            if (index === this.typeDropdownSelectedIndex) {
                item.classList.add('selected');
            }
            item.textContent = type;
            item.addEventListener('mousedown', (e) => {
                e.preventDefault(); // keep focus on input
                this.selectAircraftTypeSuggestion(index);
            });
            item.addEventListener('mouseenter', () => {
                const prev = dropdown.querySelector('.modal-actype-dropdown-item.selected');
                if (prev) prev.classList.remove('selected');
                item.classList.add('selected');
                this.typeDropdownSelectedIndex = index;
            });
            dropdown.appendChild(item);
        });

        dropdown.style.display = 'block';

        if (this.typeDropdownSelectedIndex >= 0) {
            const selectedEl = dropdown.children[this.typeDropdownSelectedIndex] as HTMLElement;
            if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest' });
        }
    }

    /**
     * Commit a type suggestion to the input field
     */
    private selectAircraftTypeSuggestion(index: number): void {
        const typeInput = document.getElementById('aircraft-type-input') as HTMLInputElement;
        if (!typeInput || index < 0 || index >= this.typeDropdownSuggestions.length) return;

        typeInput.value = this.typeDropdownSuggestions[index];
        this.hideAircraftTypeDropdown();
        this.updateAircraftTypeWarning();
        typeInput.focus();
    }

    /**
     * Hide the aircraft type dropdown
     */
    private hideAircraftTypeDropdown(): void {
        const dropdown = document.getElementById('aircraft-type-dropdown') as HTMLDivElement;
        if (dropdown) dropdown.style.display = 'none';
        this.typeDropdownSuggestions = [];
        this.typeDropdownSelectedIndex = -1;
    }

    /**
     * Show a warning under the type input when the typed value is not part
     * of the openap aircraft list. Never blocks submission - custom types
     * are intentionally allowed.
     */
    private updateAircraftTypeWarning(): void {
        const typeInput = document.getElementById('aircraft-type-input') as HTMLInputElement;
        const warning = document.getElementById('aircraft-type-warning') as HTMLElement;
        if (!typeInput || !warning) return;

        const value = typeInput.value.trim();
        if (value.length === 0) {
            warning.style.display = 'none';
            return;
        }

        if (isOpenapAircraftType(value)) {
            warning.style.display = 'none';
        } else {
            warning.textContent = `openap library does not include "${value.toUpperCase()}"`;
            warning.style.display = 'block';
        }
    }

    /**
     * Check if aircraft ID already exists
     */
    private aircraftExists(aircraftId: string): boolean {
        if (!window.app) {
            logger.warn('AircraftCreationManager', '✈️ App not available, cannot check aircraft existence');
            return false;
        }

        const state = window.app.getState();
        const aircraftData = state.aircraftData;

        if (!aircraftData || !aircraftData.id) {
            return false;
        }

        // Check if the ID exists in the current aircraft list (case-insensitive)
        const upperCaseId = aircraftId.toUpperCase();
        return aircraftData.id.some(existingId => existingId.toUpperCase() === upperCaseId);
    }

    /**
     * Refresh the duplicate-ID warning under the aircraft ID input.
     * Non-blocking: this only shows/hides the warning, it never prevents
     * submission.
     */
    private updateAircraftIdWarning(): void {
        const idInput = document.getElementById('aircraft-id-input') as HTMLInputElement;
        if (!idInput) return;

        const id = idInput.value.trim();

        if (!id || !this.aircraftExists(id)) {
            this.hideAircraftIdWarning();
            return;
        }

        this.showAircraftIdWarning(`Aircraft "${id.toUpperCase()}" already exists`);
    }

    /**
     * Show the duplicate-ID warning (orange, matches the openap type warning)
     */
    private showAircraftIdWarning(message: string): void {
        const idInput = document.getElementById('aircraft-id-input') as HTMLInputElement;
        if (!idInput) return;

        // Orange border to hint at a non-blocking warning
        idInput.style.borderColor = '#ff9800';
        idInput.style.borderWidth = '2px';

        // Get or create the warning message element
        let warningElement = document.getElementById('aircraft-id-warning');
        if (!warningElement) {
            warningElement = document.createElement('small');
            warningElement.id = 'aircraft-id-warning';
            warningElement.className = 'modal-field-warning';
            // Insert right after the input field
            idInput.parentElement?.insertBefore(warningElement, idInput.nextSibling);
        }

        warningElement.textContent = message;
        warningElement.style.display = 'block';
    }

    /**
     * Hide the duplicate-ID warning
     */
    private hideAircraftIdWarning(): void {
        const idInput = document.getElementById('aircraft-id-input') as HTMLInputElement;
        if (idInput) {
            idInput.style.borderColor = '';
            idInput.style.borderWidth = '';
        }

        const warningElement = document.getElementById('aircraft-id-warning');
        if (warningElement) {
            warningElement.style.display = 'none';
        }
    }

    /**
     * Create aircraft using manual input
     */
    private createAircraftManual(): void {
        // Get input values
        const idInput = document.getElementById('aircraft-id-input') as HTMLInputElement;
        const typeInput = document.getElementById('aircraft-type-input') as HTMLInputElement;
        const latInput = document.getElementById('aircraft-lat-input') as HTMLInputElement;
        const lonInput = document.getElementById('aircraft-lon-input') as HTMLInputElement;
        const hdgInput = document.getElementById('aircraft-hdg-input') as HTMLInputElement;
        const altInput = document.getElementById('aircraft-alt-input') as HTMLInputElement;
        const spdInput = document.getElementById('aircraft-spd-input') as HTMLInputElement;

        const id = idInput?.value.trim();
        const type = typeInput?.value.trim();
        const lat = latInput?.value;
        const lon = lonInput?.value;
        const hdg = hdgInput?.value;
        const alt = altInput?.value;
        const spd = spdInput?.value;

        // Validate inputs
        if (!id) {
            alert('Please enter an aircraft ID');
            idInput?.focus();
            return;
        }

        // Duplicate-ID check is advisory only (non-blocking). Refresh the
        // warning so it reflects the latest value, then continue.
        this.updateAircraftIdWarning();

        if (!type) {
            alert('Please enter an aircraft type');
            typeInput?.focus();
            return;
        }

        if (!lat || !lon || !hdg || !alt || !spd) {
            alert('Please fill in all required fields');
            return;
        }

        // Parse numeric values
        const latitude = parseFloat(lat);
        const longitude = parseFloat(lon);
        const heading = parseFloat(hdg);
        const altitudeDisplay = parseFloat(alt);
        const speedDisplay = parseFloat(spd);

        // Validate ranges
        if (latitude < -90 || latitude > 90) {
            alert('Latitude must be between -90 and 90');
            latInput?.focus();
            return;
        }

        if (longitude < -180 || longitude > 180) {
            alert('Longitude must be between -180 and 180');
            lonInput?.focus();
            return;
        }

        if (heading < 0 || heading > 360) {
            alert('Heading must be between 0 and 360');
            hdgInput?.focus();
            return;
        }

        // Get current units and convert to BlueSky format (feet and knots)
        const currentAltUnit = this.getCurrentAltitudeUnit();
        const currentSpeedUnit = this.getCurrentSpeedUnit();
        const altFeet = this.convertAltitudeToFeet(altitudeDisplay, currentAltUnit);
        const speedKnots = this.convertSpeedToKnots(speedDisplay, currentSpeedUnit);

        logger.debug('AircraftCreationManager', `Unit conversion: ${altitudeDisplay}${currentAltUnit} → ${altFeet}ft, ${speedDisplay}${currentSpeedUnit} → ${speedKnots}kts`);

        // Generate CRE command
        // Format: CRE acid,type,lat,lon,hdg,alt,spd
        const command = `CRE ${id},${type},${latitude},${longitude},${heading},${altFeet},${speedKnots}`;

        logger.info('AircraftCreationManager', 'Creating aircraft:', command);

        // Send command to BlueSky
        if (window.app) {
            window.app.sendCommand(command);
            logger.debug('AircraftCreationManager', 'Command sent to BlueSky');

            // Display the command in the console
            logger.debug('AircraftCreationManager', 'Getting console instance from app');
            const consoleInstance = window.app.getConsole();
            logger.debug('AircraftCreationManager', 'Console instance:', consoleInstance);

            if (consoleInstance) {
                logger.debug('AircraftCreationManager', 'Calling displaySentCommand with:', command);
                consoleInstance.displaySentCommand(command);
            } else {
                logger.warn('AircraftCreationManager', 'Console instance is null');
            }
        } else {
            logger.error('AircraftCreationManager', '✈️ Cannot send command: app not available');
        }

        // Close modal
        this.closeModal();
    }

    /**
     * Stop aircraft drawing mode
     */
    private stopAircraftDrawing(): void {
        this.aircraftDrawingMode = false;
        this.aircraftDrawingPoints = [];
        this.currentAircraftData = null;

        // Disable map drawing
        this.disableAircraftMapDrawing();

        // Hide drawing banner
        this.hideDrawingBanner();

        logger.debug('AircraftCreationManager', 'Stopped aircraft drawing mode');
    }

    /**
     * Enable aircraft map drawing
     */
    private enableAircraftMapDrawing(): void {
        const map = this.mapDisplay.getMap();
        if (!map) {
            logger.warn('AircraftCreationManager', 'No radar map available for aircraft drawing');
            return;
        }

        // Add click handler for aircraft positioning
        this.aircraftMapClickHandler = (e: any) => {
            this.handleAircraftMapClick(e);
        };

        map.on('click', this.aircraftMapClickHandler);

        // Highlight the navaid the cursor would snap to. This runs for both
        // phases: the first click (position) and the second click (heading
        // direction), so the user can aim the heading at a known navaid.
        this.aircraftSnapHoverHandler = (e: any) => {
            if (this.aircraftDrawingPoints.length < 2) {
                this.navaidSnapper.highlight(e);
            }
        };
        map.on('mousemove', this.aircraftSnapHoverHandler);

        // Show drawing banner
        logger.debug('AircraftCreationManager', 'About to show drawing mode and banner');
        this.showDrawingBanner();
        this.updateDrawingBanner('Click on map to set aircraft position');
        logger.debug('AircraftCreationManager', 'Drawing mode and banner should now be visible');

        logger.debug('AircraftCreationManager', 'Enabled aircraft map drawing');
    }

    /**
     * Disable aircraft map drawing
     */
    private disableAircraftMapDrawing(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        if (this.aircraftMapClickHandler) {
            map.off('click', this.aircraftMapClickHandler);
            this.aircraftMapClickHandler = null;
        }

        if (this.aircraftMouseMoveHandler) {
            map.off('mousemove', this.aircraftMouseMoveHandler);
            this.aircraftMouseMoveHandler = null;
        }

        if (this.aircraftSnapHoverHandler) {
            map.off('mousemove', this.aircraftSnapHoverHandler);
            this.aircraftSnapHoverHandler = null;
        }
        this.navaidSnapper.clearHighlight();

        // Remove escape key handler
        if (this.aircraftEscapeHandler) {
            document.removeEventListener('keydown', this.aircraftEscapeHandler);
            this.aircraftEscapeHandler = null;
        }

        // Clear stored position
        this.aircraftPosition = null;

        // Clear temporary aircraft visualization
        this.clearTemporaryAircraftDrawing();

        logger.debug('AircraftCreationManager', 'Disabled aircraft map drawing');
    }

    /**
     * Handle aircraft map click
     */
    private handleAircraftMapClick(e: any): void {
        if (!this.aircraftDrawingMode) {
            logger.debug('AircraftCreationManager', 'Aircraft drawing mode not active, ignoring click');
            return;
        }

        // Snap both clicks to a nearby navaid when enabled: the first click sets
        // the spawn position, the second sets the heading/direction (aim at a
        // known navaid for a precise heading).
        let point: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        const snapped = this.navaidSnapper.snap(e);
        if (snapped) point = [snapped.lng, snapped.lat];
        this.aircraftDrawingPoints.push(point);

        logger.debug('AircraftCreationManager', `Aircraft click ${this.aircraftDrawingPoints.length} at [${point[1].toFixed(4)}, ${point[0].toFixed(4)}]`);

        if (this.aircraftDrawingPoints.length === 1) {
            // First click - set position. Keep the snap highlight active so the
            // heading click can also snap to a navaid.
            this.updateDrawingBanner('Move mouse to see heading guide, then click to confirm direction');
            this.visualizeAircraftPosition(point);
        } else if (this.aircraftDrawingPoints.length === 2) {
            // Second click - set heading and create aircraft
            logger.debug('AircraftCreationManager', 'Second click detected, completing aircraft drawing');
            this.completeAircraftDrawing();
        }
    }

    /**
     * Visualize aircraft position
     */
    private visualizeAircraftPosition(position: [number, number]): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        // Add simple circle visualization (like line drawing)
        const aircraftSource = {
            'type': 'geojson' as const,
            'data': {
                'type': 'FeatureCollection' as const,
                'features': [{
                    'type': 'Feature' as const,
                    'geometry': {
                        'type': 'Point' as const,
                        'coordinates': position
                    },
                    'properties': {}
                }]
            }
        };

        // Clean up existing visualization
        if (map.getSource('temp-aircraft-position')) {
            map.removeLayer('temp-aircraft-position-layer');
            map.removeSource('temp-aircraft-position');
        }

        // Add simple circle layer (like line drawing)
        map.addSource('temp-aircraft-position', aircraftSource);
        map.addLayer({
            'id': 'temp-aircraft-position-layer',
            'type': 'circle',
            'source': 'temp-aircraft-position',
            'paint': {
                'circle-radius': 8,
                'circle-color': '#ff6600',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#ffffff'
            }
        });

        // Store position for guide line
        this.aircraftPosition = position;

        // Add mouse move handler for guide line. Snap the guide endpoint to a
        // nearby navaid so the previewed heading matches what the second click
        // will commit.
        this.aircraftMouseMoveHandler = (e: any) => {
            const snapped = this.navaidSnapper.snap(e);
            const guidePos = snapped ? { lng: snapped.lng, lat: snapped.lat } : e.lngLat;
            this.updateHeadingGuideLine(guidePos);
        };

        map.on('mousemove', this.aircraftMouseMoveHandler);

        // Add escape key handler to exit drawing mode
        this.aircraftEscapeHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                logger.debug('AircraftCreationManager', 'Escape pressed, exiting aircraft drawing mode');
                this.stopAircraftDrawing();
            }
        };

        document.addEventListener('keydown', this.aircraftEscapeHandler);
    }

    /**
     * Update heading guide line
     */
    private updateHeadingGuideLine(mousePosition: { lng: number, lat: number }): void {
        const map = this.mapDisplay.getMap();
        if (!map || !this.aircraftPosition) return;

        // Create guide line from aircraft position to mouse cursor
        const guideLineSource = {
            'type': 'geojson' as const,
            'data': {
                'type': 'FeatureCollection' as const,
                'features': [{
                    'type': 'Feature' as const,
                    'geometry': {
                        'type': 'LineString' as const,
                        'coordinates': [this.aircraftPosition, [mousePosition.lng, mousePosition.lat]]
                    },
                    'properties': {}
                }]
            }
        };

        // Update or create guide line
        if (map.getSource('temp-aircraft-guideline')) {
            (map.getSource('temp-aircraft-guideline') as any).setData(guideLineSource.data);
        } else {
            map.addSource('temp-aircraft-guideline', guideLineSource);
            map.addLayer({
                'id': 'temp-aircraft-guideline-layer',
                'type': 'line',
                'source': 'temp-aircraft-guideline',
                'layout': {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                'paint': {
                    'line-color': '#ff6600',
                    'line-width': 2,
                    'line-dasharray': [3, 3],
                    'line-opacity': 0.8
                }
            });
        }

        // Calculate aviation heading for display (0° = North, 90° = East)
        const lat1 = this.aircraftPosition[1] * Math.PI / 180;
        const lat2 = mousePosition.lat * Math.PI / 180;
        const deltaLng = (mousePosition.lng - this.aircraftPosition[0]) * Math.PI / 180;

        const y = Math.sin(deltaLng) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

        let mathAngle = Math.atan2(y, x) * 180 / Math.PI;
        let heading = Math.round((mathAngle + 360) % 360); // Round to nearest degree

        // Update drawing banner with current heading
        this.updateDrawingBanner(`Heading: ${heading}° - Click to confirm direction`);
    }

    /**
     * Complete aircraft drawing
     */
    private completeAircraftDrawing(): void {
        if (this.aircraftDrawingPoints.length < 2 || !this.currentAircraftData) {
            logger.warn('AircraftCreationManager', 'Insufficient data for aircraft creation');
            return;
        }

        const position = this.aircraftDrawingPoints[0];
        const headingPoint = this.aircraftDrawingPoints[1];

        // Calculate aviation heading (0° = North, 90° = East, 180° = South, 270° = West)
        const lat1 = position[1] * Math.PI / 180;
        const lat2 = headingPoint[1] * Math.PI / 180;
        const deltaLng = (headingPoint[0] - position[0]) * Math.PI / 180;

        const y = Math.sin(deltaLng) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

        // Math.atan2 gives mathematical angle: 0° = East, 90° = North, -90° = South, 180°/-180° = West
        // Convert to aviation heading: 0° = North, 90° = East, 180° = South, 270° = West
        let mathAngle = Math.atan2(y, x) * 180 / Math.PI;

        // Geographic calculation already gives correct aviation angles:
        // North=0°, East=90°, South=180°, West=-90°
        // Just need to normalize negative West angle (-90° → 270°)
        let heading = (mathAngle + 360) % 360;
        heading = Math.round(heading);

        logger.debug('AircraftCreationManager', `Position: [${position[1].toFixed(4)}, ${position[0].toFixed(4)}] → [${headingPoint[1].toFixed(4)}, ${headingPoint[0].toFixed(4)}]`);
        logger.debug('AircraftCreationManager', `Heading calculation: mathAngle=${mathAngle.toFixed(1)}°, aviation=${heading}°`);

        // Convert units to BlueSky format (always feet and knots)
        const altFeet = this.convertAltitudeToFeet(this.currentAircraftData.altDisplay, this.currentAircraftData.altUnit);
        const speedKnots = this.convertSpeedToKnots(this.currentAircraftData.spdDisplay, this.currentAircraftData.spdUnit);

        logger.debug('AircraftCreationManager', `Unit conversion: ${this.currentAircraftData.altDisplay}${this.currentAircraftData.altUnit} → ${altFeet}ft, ${this.currentAircraftData.spdDisplay}${this.currentAircraftData.spdUnit} → ${speedKnots}kts`);

        // Build and send CRE command
        const command = `CRE ${this.currentAircraftData.id},${this.currentAircraftData.actype},${position[1]},${position[0]},${heading},${altFeet},${speedKnots}`;

        logger.info('AircraftCreationManager', `Creating aircraft with command: ${command}`);
        logger.debug('AircraftCreationManager', `Position: [${position[1]}, ${position[0]}], Heading: ${heading}°`);

        // Send command to BlueSky
        if (window.app) {
            window.app.sendCommand(command);
            logger.debug('AircraftCreationManager', 'Command sent to BlueSky');

            // Display the command in the console
            logger.debug('AircraftCreationManager', '(map mode) Getting console instance from app');
            const consoleInstance = window.app.getConsole();
            logger.debug('AircraftCreationManager', '(map mode) Console instance:', consoleInstance);

            if (consoleInstance) {
                logger.debug('AircraftCreationManager', '(map mode) Calling displaySentCommand with:', command);
                consoleInstance.displaySentCommand(command);
            } else {
                logger.warn('AircraftCreationManager', '(map mode) Console instance is null');
            }
        } else {
            logger.error('AircraftCreationManager', '✈️ Cannot send command: app not available');
        }

        // Clean up drawing state
        this.stopAircraftDrawing();
    }

    /**
     * Clear temporary aircraft drawing
     */
    private clearTemporaryAircraftDrawing(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        // Remove temporary layers and sources
        const layersToRemove = ['temp-aircraft-position-layer', 'temp-aircraft-guideline-layer'];
        const sourcesToRemove = ['temp-aircraft-position', 'temp-aircraft-guideline'];

        layersToRemove.forEach(layerId => {
            if (map.getLayer(layerId)) {
                map.removeLayer(layerId);
            }
        });

        sourcesToRemove.forEach(sourceId => {
            if (map.getSource(sourceId)) {
                map.removeSource(sourceId);
            }
        });

        logger.debug('AircraftCreationManager', 'Cleared temporary aircraft drawing visualization');
    }

    /**
     * Show drawing banner
     */
    private showDrawingBanner(): void {
        const banner = document.getElementById('drawing-banner');

        if (banner) banner.style.display = 'flex';

        logger.debug('AircraftCreationManager', 'Showing drawing mode banner');
    }

    /**
     * Hide drawing banner
     */
    private hideDrawingBanner(): void {
        const banner = document.getElementById('drawing-banner');

        if (banner) banner.style.display = 'none';

        logger.debug('AircraftCreationManager', 'Hiding drawing mode banner');
    }

    /**
     * Update drawing banner message
     */
    private updateDrawingBanner(message: string): void {
        const bannerText = document.getElementById('drawing-banner-text');

        if (bannerText) {
            bannerText.textContent = message;
        }
    }
}
