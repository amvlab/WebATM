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
import { logger } from '../../../utils/Logger';

export class AircraftInfoPanel extends BasePanel {
    private aircraftInfoElement: HTMLElement | null = null;
    private stateManager: StateManager | null = null;
    private currentAircraftData: AircraftData | null = null;
    private selectedAircraft: string | null = null;
    private lastAircraftInfoData: any = null;
    private displayOptions: DisplayOptions | null = null;

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
            }
        });
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
            this.aircraftInfoElement.innerHTML = '<div class="no-selection">No aircraft selected</div>';
            this.lastAircraftInfoData = null;
            return;
        }

        // Find aircraft index
        const index = this.currentAircraftData.id.indexOf(this.selectedAircraft);

        if (index === -1) {
            // Aircraft not found in current data
            this.aircraftInfoElement.innerHTML = '<div class="no-selection">Aircraft not found</div>';
            this.lastAircraftInfoData = null;
            return;
        }

        const data = this.currentAircraftData;

        // Get aircraft data (in BlueSky units: alt in ft, speeds in kt, vs in ft/s)
        const aircraftId = data.id[index];
        const lat = data.lat[index];
        const lon = data.lon[index];
        const altFeet = data.alt[index];
        const casKnots = (data.cas && data.cas[index]) || null;  // May not be available from backend yet
        const tasKnots = data.tas[index];
        const gsKnots = (data.gs && data.gs[index]) || null;  // May not be available from backend yet
        const trk = data.trk[index];
        const vsFtPerSec = data.vs[index];
        const inconf = data.inconf[index];
        const tcpamax = data.tcpamax[index];

        // Create info object for comparison
        const currentInfo = {
            aircraftId, lat, lon, altFeet, casKnots, tasKnots, gsKnots, trk, vsFtPerSec, inconf, tcpamax,
            // Include display options in comparison to trigger update on unit changes
            speedUnit: this.displayOptions.speedUnit,
            altUnit: this.displayOptions.altitudeUnit,
            vsUnit: this.displayOptions.verticalSpeedUnit
        };

        // Check if data actually changed (avoid unnecessary DOM updates)
        if (this.lastAircraftInfoData &&
            JSON.stringify(currentInfo) === JSON.stringify(this.lastAircraftInfoData)) {
            return; // No change, skip update
        }

        this.lastAircraftInfoData = currentInfo;

        // Format values using DataProcessor with current units
        const latStr = lat.toFixed(6);
        const lonStr = lon.toFixed(6);
        const altStr = DataProcessor.formatAltitude(altFeet, this.displayOptions.altitudeUnit);

        // Handle potentially missing speed data from backend
        const casStr = casKnots !== null
            ? DataProcessor.formatSpeed(casKnots, this.displayOptions.speedUnit)
            : `N/A (using TAS: ${DataProcessor.formatSpeed(tasKnots, this.displayOptions.speedUnit)})`;
        const tasStr = DataProcessor.formatSpeed(tasKnots, this.displayOptions.speedUnit);
        const gsStr = gsKnots !== null
            ? DataProcessor.formatSpeed(gsKnots, this.displayOptions.speedUnit)
            : `N/A (using TAS: ${DataProcessor.formatSpeed(tasKnots, this.displayOptions.speedUnit)})`;

        const trkDeg = Math.round(trk);
        const vsStr = DataProcessor.formatVerticalSpeed(vsFtPerSec, this.displayOptions.verticalSpeedUnit);
        const confStatus = inconf ? 'CONFLICT' : 'Clear';
        const confClass = inconf ? 'conflict-warning' : 'conflict-clear';
        const tcpaStr = tcpamax !== undefined ? tcpamax.toFixed(1) : 'N/A';

        // Build HTML - showing all three speeds
        const html = `
            <div class="aircraft-info-grid">
                <div class="info-row">
                    <span class="info-label">Aircraft ID:</span>
                    <span class="info-value copyable-value" data-field="id">${aircraftId}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Latitude:</span>
                    <span class="info-value copyable-value" data-field="lat">${latStr}°</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Longitude:</span>
                    <span class="info-value copyable-value" data-field="lon">${lonStr}°</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Altitude:</span>
                    <span class="info-value copyable-value" data-field="alt">${altStr}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">CAS:</span>
                    <span class="info-value copyable-value" data-field="cas">${casStr}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">TAS:</span>
                    <span class="info-value copyable-value" data-field="tas">${tasStr}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">GS:</span>
                    <span class="info-value copyable-value" data-field="gs">${gsStr}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Track:</span>
                    <span class="info-value copyable-value" data-field="trk">${trkDeg}°</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Vertical Speed:</span>
                    <span class="info-value copyable-value" data-field="vs">${vsStr}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Conflict Status:</span>
                    <span class="info-value ${confClass}">${confStatus}</span>
                </div>
                ${inconf ? `
                <div class="info-row">
                    <span class="info-label">Time to CPA:</span>
                    <span class="info-value">${tcpaStr} s</span>
                </div>
                ` : ''}
            </div>
        `;

        this.aircraftInfoElement.innerHTML = html;

        // Add click handlers for copyable values
        this.setupCopyableFields();
    }

    /**
     * Setup copyable field functionality
     */
    private setupCopyableFields(): void {
        if (!this.aircraftInfoElement) return;

        const copyableElements = this.aircraftInfoElement.querySelectorAll('.copyable-value');
        copyableElements.forEach(element => {
            const htmlElement = element as HTMLElement;
            htmlElement.addEventListener('click', async () => {
                const textToCopy = htmlElement.textContent || '';
                const fieldName = htmlElement.getAttribute('data-field') || 'value';

                try {
                    await navigator.clipboard.writeText(textToCopy);

                    // Visual feedback
                    const originalText = htmlElement.textContent;
                    htmlElement.textContent = 'Copied!';
                    htmlElement.style.color = '#4CAF50';

                    setTimeout(() => {
                        htmlElement.textContent = originalText;
                        htmlElement.style.color = '';
                    }, 1000);

                    logger.debug('AircraftInfoPanel', `Copied ${fieldName}: ${textToCopy}`);
                } catch (err) {
                    logger.error('AircraftInfoPanel', 'Failed to copy text:', err);
                }
            });
        });
    }

    /**
     * Clear the aircraft info display
     */
    public clearInfo(): void {
        if (this.aircraftInfoElement) {
            this.aircraftInfoElement.innerHTML = '<div class="no-selection">No aircraft selected</div>';
            this.lastAircraftInfoData = null;
        }
    }

    /**
     * Get currently displayed aircraft ID
     */
    public getDisplayedAircraft(): string | null {
        return this.selectedAircraft;
    }

    protected onDestroy(): void {
        this.lastAircraftInfoData = null;
    }
}
