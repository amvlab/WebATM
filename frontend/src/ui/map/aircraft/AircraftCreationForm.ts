import { modalManager } from '../../ModalManager';
import { SpeedUnit, AltitudeUnit } from '../../../data/types';
import { DataProcessor } from '../../../data/DataProcessor';
import { OPENAP_AIRCRAFT_TYPES, isOpenapAircraftType } from '../../../data/aircraftTypes';
import { logger } from '../../../utils/Logger';
import { Dropdown } from '../../../utils/dropdown';

/**
 * Form values captured for map-based creation: everything except the
 * position/heading, which the user draws on the map afterwards.
 */
export interface AircraftCreationData {
    id: string;
    actype: string; // Aircraft type
    altDisplay: number;
    altUnit: AltitudeUnit;
    spdDisplay: number;
    spdUnit: SpeedUnit;
}

/**
 * Convert altitude from any unit to feet (for BlueSky commands)
 */
export function convertAltitudeToFeet(value: number, fromUnit: AltitudeUnit): number {
    if (isNaN(value)) return NaN;
    return Math.round(DataProcessor.altitudeToFeet(value, fromUnit));
}

/**
 * Convert speed from any unit to knots (for BlueSky commands)
 */
export function convertSpeedToKnots(value: number, fromUnit: SpeedUnit): number {
    if (isNaN(value)) return NaN;
    return Math.round(DataProcessor.speedToKnots(value, fromUnit));
}

/**
 * AircraftCreationForm - the Create Aircraft modal, extracted from
 * AircraftCreationManager.
 *
 * Owns the form half of aircraft creation: input validation, unit
 * labels/conversion, the aircraft-type autocomplete with openap warning,
 * the advisory duplicate-ID warning, and CRE command generation for
 * manual mode. Map mode hands the validated form data to the manager via
 * the onStartDrawing callback, which runs the map drawing state machine.
 */
export class AircraftCreationForm {
    private creationMode: 'manual' | 'map' = 'manual';

    // Aircraft type autocomplete dropdown (for the Create Aircraft modal)
    private typeDropdown: Dropdown<string> | null = null;

    constructor(private readonly onStartDrawing: (data: AircraftCreationData) => void) {
        this.setupModalHandlers();
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

            logger.debug('AircraftCreationForm', 'Showing aircraft creation modal');
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
            let unitLabel: string;
            let placeholder: string;

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

        logger.debug('AircraftCreationForm', `Updated unit labels: altitude=${currentAltUnit}, speed=${currentSpeedUnit}`);
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
        this.typeDropdown?.hide();
        const typeWarning = document.getElementById('aircraft-type-warning');
        if (typeWarning) typeWarning.style.display = 'none';

        // Reset to manual mode
        const modeSelect = document.getElementById('aircraft-creation-mode') as HTMLSelectElement;
        if (modeSelect) modeSelect.value = 'manual';

        logger.debug('AircraftCreationForm', 'Closed aircraft creation modal');
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
        logger.debug('AircraftCreationForm', 'Start drawing aircraft on map');

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

        // Capture aircraft data with current unit selections
        const data: AircraftCreationData = {
            id: id,
            actype: type,
            altDisplay: parseFloat(alt),
            altUnit: this.getCurrentAltitudeUnit(),
            spdDisplay: parseFloat(spd),
            spdUnit: this.getCurrentSpeedUnit()
        };

        // Close modal (but don't stop drawing) and hand off to the map
        // drawing state machine.
        this.closeModal();
        this.onStartDrawing(data);

        logger.debug('AircraftCreationForm', 'Started aircraft drawing mode');
    }

    /**
     * Set up autocomplete dropdown + openap warning for the aircraft type input.
     * Backed by the shared Dropdown<T> helper (same one Console uses for ACID
     * and aircraft-type completions).
     */
    private setupAircraftTypeAutocomplete(): void {
        const typeInput = document.getElementById('aircraft-type-input') as HTMLInputElement;
        const wrapper = typeInput?.closest('.actype-input-wrapper') as HTMLElement | null;
        if (!typeInput || !wrapper) return;

        this.typeDropdown = new Dropdown<string>({
            container: wrapper,
            rootClass: 'modal-actype-dropdown',
            itemClass: 'modal-actype-dropdown-item',
            renderItem: (type) => type,
            onSelect: (type) => {
                typeInput.value = type;
                this.typeDropdown?.hide();
                this.updateAircraftTypeWarning();
                typeInput.focus();
            }
        });

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
            if (this.typeDropdown?.handleKey(e.key)) {
                e.preventDefault();
            }
        });

        // Hide dropdown on blur (with a small delay so mousedown selection fires)
        typeInput.addEventListener('blur', () => {
            setTimeout(() => {
                this.typeDropdown?.hide();
                this.updateAircraftTypeWarning();
            }, 150);
        });
    }

    /**
     * Refresh the aircraft type dropdown with the current filter value
     */
    private updateAircraftTypeDropdown(): void {
        const typeInput = document.getElementById('aircraft-type-input') as HTMLInputElement;
        if (!typeInput || !this.typeDropdown) return;

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

        // Hide if exact-only match (nothing left to pick) or no matches at all
        // (let the user type a custom type freely).
        if (filtered.length === 0 || (filtered.length === 1 && filtered[0] === upperPartial)) {
            this.typeDropdown.hide();
            return;
        }

        this.typeDropdown.setItems(filtered);
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
            logger.warn('AircraftCreationForm', '✈️ App not available, cannot check aircraft existence');
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
        const altFeet = convertAltitudeToFeet(altitudeDisplay, currentAltUnit);
        const speedKnots = convertSpeedToKnots(speedDisplay, currentSpeedUnit);

        logger.debug('AircraftCreationForm', `Unit conversion: ${altitudeDisplay}${currentAltUnit} → ${altFeet}ft, ${speedDisplay}${currentSpeedUnit} → ${speedKnots}kts`);

        // Generate CRE command
        // Format: CRE acid,type,lat,lon,hdg,alt,spd
        const command = `CRE ${id},${type},${latitude},${longitude},${heading},${altFeet},${speedKnots}`;

        logger.info('AircraftCreationForm', 'Creating aircraft:', command);

        // Send command to BlueSky
        if (window.app) {
            window.app.sendCommand(command);
            logger.debug('AircraftCreationForm', 'Command sent to BlueSky');

            // Display the command in the console
            const consoleInstance = window.app.getConsole();
            if (consoleInstance) {
                consoleInstance.displaySentCommand(command);
            } else {
                logger.warn('AircraftCreationForm', 'Console instance is null');
            }
        } else {
            logger.error('AircraftCreationForm', '✈️ Cannot send command: app not available');
        }

        // Close modal
        this.closeModal();
    }
}
