import { modalManager } from '../../ModalManager';
import type { App } from '../../../core/App';
import { DataProcessor } from '../../../data/DataProcessor';
import { AltitudeUnit, SpeedUnit } from '../../../data/types';
import { logger } from '../../../utils/Logger';

const MODAL_ID = 'route-constraints-modal';

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
 * RouteConstraintsModal - Per-waypoint constraint modal plus the ADDWPT
 * command build/send pipeline. The drawing manager hands over a finished
 * route snapshot and is notified back via onComplete/onCancel.
 */
export class RouteConstraintsModal {
    private app: App;
    private onComplete: () => void;
    private onCancel: () => void;

    private active: ActiveRoute | null = null;
    private constraintRows: WaypointConstraint[] = [];
    // Blocks re-entrant submits (double-click) and stops a mid-send modal
    // close from reporting the route as cancelled.
    private sending = false;
    // Index of the first waypoint command not yet sent. A retry after a
    // failed submit resumes here instead of re-sending (and duplicating)
    // waypoints BlueSky already accepted.
    private nextSendIndex = 0;

    constructor(app: App, onComplete: () => void, onCancel: () => void) {
        this.app = app;
        this.onComplete = onComplete;
        this.onCancel = onCancel;
        this.setupModalHandlers();
    }

    private setupModalHandlers(): void {
        const submitBtn = document.getElementById('submit-route-constraints-btn');
        if (submitBtn) {
            submitBtn.addEventListener('click', () => void this.submit());
        }

        const cancelBtn = document.getElementById('cancel-route-constraints-btn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => modalManager.close(MODAL_ID));
        }

        // ModalManager owns the other close paths (X, backdrop, Escape).
        // Any close while a route is still pending counts as a cancel;
        // submit() clears `active` before closing so success doesn't
        // double-report as a cancel.
        modalManager.on(MODAL_ID, (event) => {
            if (event === 'close' && this.active && !this.sending) {
                this.active = null;
                this.onCancel();
            }
        });
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
        this.nextSendIndex = 0;

        const table = document.getElementById('route-constraints-table') as HTMLTableElement | null;
        if (!table) {
            logger.error('RouteConstraintsModal', 'route-constraints-table not found in DOM');
            // Submit unconstrained so the drawn route isn't silently dropped.
            void this.submit();
            return;
        }

        const altUnitLabel = DataProcessor.altitudeUnitLabel(altUnit);
        const spdUnitLabel = DataProcessor.speedUnitLabel(spdUnit);

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
            // Same fallback as a missing table: submit unconstrained rather
            // than stranding the route with no modal and no callback.
            void this.submit();
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

        modalManager.open(MODAL_ID);
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
     * Send the ADDWPT commands sequentially with a small delay between them:
     * back-to-back sends race on the proxy's shared ZMQ socket and crash
     * BlueSky with msgpack "ExtraData" errors.
     */
    private async submit(): Promise<void> {
        if (this.sending) return;
        if (!this.active || this.active.points.length < 1) {
            logger.warn('RouteConstraintsModal', 'submit called without a valid route');
            return;
        }

        this.applyBulkConstraintsIfEnabled();

        // Regenerated on every (re)try; commands map 1:1 to waypoints, so
        // skipping the first nextSendIndex entries resumes a partial send.
        const commands = this.generateCommands();
        const consoleInstance = this.app.getConsole();
        const acid = this.active.acid;

        // 50 ms stays snappy for small routes while giving the proxy/ZMQ
        // pipeline room to serialize sends cleanly (back-to-back sends race
        // on the shared socket and crash BlueSky with msgpack errors).
        const COMMAND_INTERVAL_MS = 50;

        logger.info(
            'RouteConstraintsModal',
            `Sending ${commands.length - this.nextSendIndex} ADDWPT command(s) for ${acid} (${COMMAND_INTERVAL_MS}ms spacing)`
        );

        this.sending = true;
        const submitBtn = document.getElementById('submit-route-constraints-btn') as HTMLButtonElement | null;
        if (submitBtn) submitBtn.disabled = true;

        try {
            while (this.nextSendIndex < commands.length) {
                const command = commands[this.nextSendIndex];
                logger.debug('RouteConstraintsModal', `Sending: ${command}`);
                const ok = await this.app.sendCommand(command);
                if (!ok) {
                    alert('Failed to send a waypoint command — check your connection. The route is kept; press Submit to retry the remaining waypoints.');
                    break;
                }
                this.nextSendIndex++;
                if (consoleInstance) {
                    consoleInstance.displaySentCommand(command);
                }
                if (this.nextSendIndex < commands.length) {
                    await this.sleep(COMMAND_INTERVAL_MS);
                }
            }

            // No POS refresh afterwards: BlueSky auto-broadcasts ROUTEDATA
            // after every ADDWPT, and an extra POS races with it.
        } catch (err) {
            logger.error('RouteConstraintsModal', 'Error sending route commands:', err);
            alert('Error sending route commands: ' + (err as Error).message);
        } finally {
            this.sending = false;
            if (submitBtn) submitBtn.disabled = false;
        }

        if (this.nextSendIndex < commands.length) {
            // Send failed part-way. Keep the route pending so Submit can
            // retry the remaining waypoints — unless the modal was closed
            // mid-send, in which case there is no UI left to retry from and
            // we report the cancel that the close event suppressed while
            // `sending` was set.
            if (!modalManager.isOpen(MODAL_ID)) {
                this.active = null;
                this.onCancel();
            }
            return;
        }

        // Clear `active` before closing so the close event isn't a cancel.
        this.active = null;
        modalManager.close(MODAL_ID);
        this.onComplete();
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Build one ADDWPT command per waypoint:
     *   ADDWPT <acid> <lat>,<lon>[,<altFt>][,<spdKts>]
     * BlueSky resolves an empty positional arg to "no constraint", so a
     * speed-only constraint keeps an empty altitude slot: <lat>,<lon>,,<spd>.
     */
    private generateCommands(): string[] {
        if (!this.active) return [];
        const { acid, points, altUnit, spdUnit } = this.active;

        return points.map((pt, i) => {
            const { alt, spd } = this.constraintRows[i] ?? { alt: null, spd: null };
            const hasAlt = alt !== null && !isNaN(alt);
            const hasSpd = spd !== null && !isNaN(spd);

            const args = [`${pt.lat.toFixed(6)},${pt.lng.toFixed(6)}`];
            if (hasAlt || hasSpd) {
                args.push(hasAlt
                    ? String(Math.round(DataProcessor.altitudeToFeet(alt, altUnit)))
                    : '');
            }
            if (hasSpd) {
                args.push(String(Math.round(DataProcessor.speedToKnots(spd, spdUnit))));
            }
            return `ADDWPT ${acid} ${args.join(',')}`;
        });
    }
}
