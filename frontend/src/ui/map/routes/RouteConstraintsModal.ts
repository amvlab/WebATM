import { modalManager } from '../../ModalManager';
import type { App } from '../../../core/App';
import { DataProcessor } from '../../../data/DataProcessor';
import { AltitudeUnit, SpeedUnit } from '../../../data/types';
import { logger } from '../../../utils/Logger';

interface WaypointConstraint {
    alt: number | null; // user-entered, in capturedAltUnit
    spd: number | null; // user-entered, in capturedSpeedUnit
}

interface ActiveRoute {
    acid: string;
    points: Array<{ lat: number; lng: number }>;
    altUnit: AltitudeUnit;
    spdUnit: SpeedUnit;
}

/**
 * RouteConstraintsModal - Owns the per-waypoint constraint modal and the
 * ADDWPT command build/send pipeline.
 *
 * The manager hands us a snapshot {acid, points, altUnit, spdUnit} when it
 * finishes drawing; we collect constraints from the user and send one
 * ADDWPT command per waypoint. We notify the manager via onComplete/onCancel
 * so it can drop its drawing state.
 */
export class RouteConstraintsModal {
    private app: App;
    private onComplete: () => void;
    private onCancel: () => void;

    private active: ActiveRoute | null = null;
    private constraintRows: WaypointConstraint[] = [];

    constructor(app: App, onComplete: () => void, onCancel: () => void) {
        this.app = app;
        this.onComplete = onComplete;
        this.onCancel = onCancel;
        this.setupModalHandlers();
    }

    private setupModalHandlers(): void {
        const submitBtn = document.getElementById('submit-route-constraints-btn');
        if (submitBtn) {
            submitBtn.addEventListener('click', () => this.submit());
        }

        const cancelBtn = document.getElementById('cancel-route-constraints-btn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => this.cancel());
        }

        const closeBtn = document.getElementById('route-constraints-modal-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.cancel());
        }
    }

    /**
     * Build the constraints modal table and open it.
     *
     * Bulk mode (default): a single Altitude/Speed pair applies to every
     * waypoint; the per-waypoint alt/spd columns are hidden. Unchecking the
     * toggle reveals per-waypoint inputs for fine-grained control.
     */
    public show(
        acid: string,
        points: Array<{ lat: number; lng: number }>,
        altUnit: AltitudeUnit,
        spdUnit: SpeedUnit
    ): void {
        this.active = { acid, points, altUnit, spdUnit };
        this.constraintRows = points.map(() => ({ alt: null, spd: null }));

        const table = document.getElementById('route-constraints-table') as HTMLTableElement | null;
        if (!table) {
            logger.error('RouteConstraintsModal', 'route-constraints-table not found in DOM');
            // If the table is missing we still fire-and-forget the submit so
            // the user's clicks aren't silently dropped.
            this.submit();
            return;
        }

        const altUnitLabel = this.altUnitLabel(altUnit);
        const spdUnitLabel = this.speedUnitLabel(spdUnit);

        const altHeader = document.getElementById('route-constraints-alt-header');
        if (altHeader) altHeader.textContent = `Altitude (${altUnitLabel})`;
        const spdHeader = document.getElementById('route-constraints-spd-header');
        if (spdHeader) spdHeader.textContent = `Speed (${spdUnitLabel})`;

        const bulkAltLabel = document.getElementById('route-constraints-bulk-alt-label');
        if (bulkAltLabel) bulkAltLabel.textContent = `Altitude (${altUnitLabel})`;
        const bulkSpdLabel = document.getElementById('route-constraints-bulk-spd-label');
        if (bulkSpdLabel) bulkSpdLabel.textContent = `Speed (${spdUnitLabel})`;

        const bulkAltInput = document.getElementById('route-constraints-bulk-alt') as HTMLInputElement | null;
        const bulkSpdInput = document.getElementById('route-constraints-bulk-spd') as HTMLInputElement | null;
        if (bulkAltInput) bulkAltInput.value = '';
        if (bulkSpdInput) bulkSpdInput.value = '';

        const target = document.getElementById('route-constraints-target');
        if (target) target.textContent = acid;

        const tbody = table.querySelector('tbody');
        if (!tbody) {
            logger.error('RouteConstraintsModal', 'route-constraints-table has no tbody');
            return;
        }
        tbody.innerHTML = '';

        const perWpAltCells: HTMLTableCellElement[] = [];
        const perWpSpdCells: HTMLTableCellElement[] = [];

        points.forEach((pt, i) => {
            const row = document.createElement('tr');

            const wpCell = document.createElement('td');
            wpCell.textContent = `WP${i + 1}`;
            row.appendChild(wpCell);

            const posCell = document.createElement('td');
            posCell.textContent = `${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)}`;
            posCell.style.fontFamily = 'monospace';
            row.appendChild(posCell);

            const altCell = document.createElement('td');
            const altInput = document.createElement('input');
            altInput.type = 'number';
            altInput.placeholder = 'optional';
            altInput.style.width = '160px';
            altInput.addEventListener('input', () => {
                const v = altInput.value.trim();
                this.constraintRows[i].alt = v === '' ? null : parseFloat(v);
            });
            altCell.appendChild(altInput);
            row.appendChild(altCell);
            perWpAltCells.push(altCell);

            const spdCell = document.createElement('td');
            const spdInput = document.createElement('input');
            spdInput.type = 'number';
            spdInput.placeholder = 'optional';
            spdInput.style.width = '160px';
            spdInput.addEventListener('input', () => {
                const v = spdInput.value.trim();
                this.constraintRows[i].spd = v === '' ? null : parseFloat(v);
            });
            spdCell.appendChild(spdInput);
            row.appendChild(spdCell);
            perWpSpdCells.push(spdCell);

            tbody.appendChild(row);
        });

        const bulkToggle = document.getElementById('route-constraints-bulk-toggle') as HTMLInputElement | null;
        const bulkInputsWrap = document.getElementById('route-constraints-bulk-inputs');

        const applyBulkMode = (bulk: boolean) => {
            const perWpDisplay = bulk ? 'none' : '';
            if (altHeader) (altHeader as HTMLElement).style.display = perWpDisplay;
            if (spdHeader) (spdHeader as HTMLElement).style.display = perWpDisplay;
            perWpAltCells.forEach(c => { c.style.display = perWpDisplay; });
            perWpSpdCells.forEach(c => { c.style.display = perWpDisplay; });
            if (bulkInputsWrap) bulkInputsWrap.style.display = bulk ? '' : 'none';
        };

        if (bulkToggle) {
            bulkToggle.checked = true;
            bulkToggle.onchange = () => applyBulkMode(bulkToggle.checked);
        }
        applyBulkMode(bulkToggle ? bulkToggle.checked : true);

        modalManager.open('route-constraints-modal');
    }

    private cancel(): void {
        modalManager.close('route-constraints-modal');
        this.active = null;
        this.onCancel();
    }

    /**
     * Populate constraintRows from the bulk inputs if bulk mode is on.
     * When bulk mode is off, constraintRows already reflect per-waypoint edits.
     */
    private applyBulkConstraintsIfEnabled(): void {
        const bulkToggle = document.getElementById('route-constraints-bulk-toggle') as HTMLInputElement | null;
        if (!bulkToggle || !bulkToggle.checked) return;
        if (!this.active) return;

        const bulkAltInput = document.getElementById('route-constraints-bulk-alt') as HTMLInputElement | null;
        const bulkSpdInput = document.getElementById('route-constraints-bulk-spd') as HTMLInputElement | null;
        const altStr = bulkAltInput?.value.trim() ?? '';
        const spdStr = bulkSpdInput?.value.trim() ?? '';
        const alt = altStr === '' ? null : parseFloat(altStr);
        const spd = spdStr === '' ? null : parseFloat(spdStr);

        this.constraintRows = this.active.points.map(() => ({ alt, spd }));
    }

    /**
     * Build and send the ADDWPT commands (one per waypoint) sequentially.
     *
     * NOTE: SocketManager.sendCommand() resolves its Promise immediately after
     * socket.emit() - it does NOT wait for the backend to finish processing.
     * Firing N commands back-to-back therefore hits the WebATM proxy within
     * microseconds of each other, and the proxy forwards them to BlueSky via
     * a shared ZMQ socket. Concurrent writes to a single ZMQ socket are not
     * thread-safe and cause msgpack "ExtraData" crashes on the BlueSky side
     * (bluesky/network/node.py unpackb error).
     *
     * We space the commands out with a small deliberate delay so the backend
     * pipeline has time to flush each ADDWPT before the next one arrives.
     */
    private async submit(): Promise<void> {
        if (!this.active || this.active.points.length < 1) {
            logger.warn('RouteConstraintsModal', 'submit called without a valid route');
            return;
        }

        this.applyBulkConstraintsIfEnabled();

        const commands = this.generateCommands();
        const consoleInstance = this.app.getConsole();
        const acid = this.active.acid;

        // Delay in ms between successive stack commands. 50 ms per waypoint
        // stays snappy for small routes (10 wpts ~= 0.5 s) while still giving
        // the proxy/ZMQ pipeline room to serialize sends cleanly.
        const COMMAND_INTERVAL_MS = 50;

        logger.info(
            'RouteConstraintsModal',
            `Sending ${commands.length} ADDWPT command(s) for ${acid} (${COMMAND_INTERVAL_MS}ms spacing)`
        );

        try {
            for (let i = 0; i < commands.length; i++) {
                const command = commands[i];
                logger.debug('RouteConstraintsModal', `Sending: ${command}`);
                const ok = await this.app.sendCommand(command);
                if (!ok) {
                    alert('Failed to send a waypoint command. Please check your connection.');
                    break;
                }
                if (consoleInstance) {
                    consoleInstance.displaySentCommand(command);
                }
                // Space out commands so the proxy/ZMQ pipeline has room to
                // serialize sends cleanly (avoids the msgpack ExtraData race
                // BlueSky hits on rapid concurrent writes to a single socket).
                if (i < commands.length - 1) {
                    await this.sleep(COMMAND_INTERVAL_MS);
                }
            }

            // BlueSky auto-broadcasts ROUTEDATA after every ADDWPT (this is
            // why the manual console ADDWPT path renders without ever sending
            // a POS). The helper used to nudge BlueSky with an extra POS
            // refresh after the final ADDWPT, but that POS races with /
            // overrides the auto-broadcast and ends up showing stale data
            // until the user clicks away. Trust the auto-broadcast and let
            // it do its job.
        } catch (err) {
            logger.error('RouteConstraintsModal', 'Error sending route commands:', err);
            alert('Error sending route commands: ' + (err as Error).message);
        }

        modalManager.close('route-constraints-modal');
        this.active = null;
        this.onComplete();
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Build one ADDWPT command per waypoint. BlueSky's ADDWPT takes optional
     * alt/spd arguments, so omitting them cleanly represents "no constraint".
     *
     * Format:
     *   ADDWPT <acid> <lat>,<lon>                    (no constraints)
     *   ADDWPT <acid> <lat>,<lon>,<altFt>            (alt only)
     *   ADDWPT <acid> <lat>,<lon>,<altFt>,<spdKts>   (alt + spd)
     *
     * If a speed is specified without an altitude, we still need an altitude
     * placeholder in the positional args; we leave that combination out and
     * warn so the user adds an altitude too.
     */
    private generateCommands(): string[] {
        if (!this.active) return [];
        const { acid, points, altUnit, spdUnit } = this.active;

        return points.map((pt, i) => {
            const row = this.constraintRows[i] || { alt: null, spd: null };

            const hasAlt = row.alt !== null && !isNaN(row.alt);
            const hasSpd = row.spd !== null && !isNaN(row.spd);

            const latlon = `${pt.lat.toFixed(6)},${pt.lng.toFixed(6)}`;

            if (!hasAlt && !hasSpd) {
                return `ADDWPT ${acid} ${latlon}`;
            }

            const altFt = hasAlt
                ? String(
                      Math.round(
                          DataProcessor.altitudeToFeet(row.alt as number, altUnit)
                      )
                  )
                : '';

            if (!hasSpd) {
                return `ADDWPT ${acid} ${latlon},${altFt}`;
            }

            const spdKts = String(
                Math.round(DataProcessor.speedToKnots(row.spd as number, spdUnit))
            );

            if (!hasAlt) {
                // BlueSky ADDWPT positional args require alt before spd; warn
                // once and emit just the position (spd will be ignored).
                logger.warn(
                    'RouteConstraintsModal',
                    `WP${i + 1}: speed provided without altitude; speed will be ignored`
                );
                return `ADDWPT ${acid} ${latlon}`;
            }

            return `ADDWPT ${acid} ${latlon},${altFt},${spdKts}`;
        });
    }

    private altUnitLabel(u: AltitudeUnit): string {
        switch (u) {
            case 'm': return 'm';
            case 'km': return 'km';
            case 'fl': return 'FL';
            case 'ft':
            default: return 'ft';
        }
    }

    private speedUnitLabel(u: SpeedUnit): string {
        switch (u) {
            case 'm/s': return 'm/s';
            case 'km/h': return 'km/h';
            case 'mph': return 'mph';
            case 'knots':
            default: return 'kt';
        }
    }
}
