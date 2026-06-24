import { MapDisplay } from '../MapDisplay';
import type { App } from '../../../core/App';
import { StateManager } from '../../../core/StateManager';
import { AltitudeUnit, SpeedUnit } from '../../../data/types';
import { logger } from '../../../utils/Logger';
import { BaseDrawingManager, DrawingPoint } from '../BaseDrawingManager';
import { RouteDrawingPreview } from './RouteDrawingPreview';
import { RouteConstraintsModal } from './RouteConstraintsModal';
import type { NavaidSnapper } from '../navdata/NavaidSnapper';

/**
 * RouteDrawingManager - Interactive waypoint route creation.
 *
 * Flow:
 *  1. User selects an aircraft (StateManager.selectedAircraft).
 *     - The "Draw Route" button is disabled + tooltipped until an aircraft is
 *       selected; subscribing to selectedAircraft state changes keeps the
 *       button in sync.
 *  2. Click "Draw Route" → toggleDrawing() → startDrawingForSelectedAircraft().
 *     - We capture the aircraft's current position and a snapshot of its
 *       existing route (if any) so that the leader line anchors correctly.
 *  3. Click on the map to drop waypoints. A solid line connects placed
 *     waypoints; a dashed "leader line" runs from either the aircraft's
 *     current position, or the last existing waypoint of an aircraft that
 *     already has a route, to the first new waypoint. A dashed cursor preview
 *     chases the pointer.
 *  4. Right-click / Enter finishes; Esc cancels.
 *  5. On finish the constraints modal opens. Each row has optional alt/spd
 *     inputs (blank = unconstrained). Units default to the GUI's current
 *     display units and are converted to feet/knots before being sent.
 *  6. On submit we emit one ADDWPT command per waypoint (BlueSky's canonical
 *     waypoint-add command, which natively supports optional alt/spd). This
 *     sidesteps the broken ADDWAYPOINTS len%6 / reshape(n,5) logic.
 *
 * Responsibilities are split across:
 *  - RouteDrawingManager (this file): state, map event wiring, banner + draw
 *    button UI, orchestration of the preview and modal.
 *  - RouteDrawingPreview: temporary MapLibre sources/layers for the preview.
 *  - RouteConstraintsModal: per-waypoint constraints UI + ADDWPT command
 *    build/send pipeline.
 */
export class RouteDrawingManager extends BaseDrawingManager {
    private app: App;
    private stateManager: StateManager;
    private preview: RouteDrawingPreview;
    private modal: RouteConstraintsModal;

    private routePoints: DrawingPoint[] = [];
    private targetAircraftId: string | null = null;

    // Anchor for the leader line. Either the aircraft's current position, or
    // the last existing waypoint of an aircraft that already has a route.
    private leaderAnchor: DrawingPoint | null = null;

    // Human-readable source of the leader anchor, snapshotted alongside
    // leaderAnchor at draw start so the banner can't drift if route data
    // changes mid-draw.
    private leaderAnchorLabel = 'aircraft';

    // Units snapshotted at draw start so the constraints modal is stable even
    // if the user toggles display units mid-flow.
    private capturedAltUnit: AltitudeUnit = 'ft';
    private capturedSpeedUnit: SpeedUnit = 'knots';

    // Enter finishes the draw, matching right-click.
    protected override readonly finishOnEnter = true;

    constructor(mapDisplay: MapDisplay, app: App, stateManager: StateManager, navaidSnapper: NavaidSnapper) {
        super(mapDisplay, navaidSnapper);
        this.app = app;
        this.stateManager = stateManager;
        this.preview = new RouteDrawingPreview(mapDisplay, stateManager);
        this.modal = new RouteConstraintsModal(
            app,
            () => this.stopDrawing(),
            () => this.cancelDrawing()
        );
        this.setupDrawRouteDisabledTooltip();

        // Keep the Draw Route button's enabled state in sync with whether an
        // aircraft is selected. Initial sync handles the page-load state.
        // NOTE: we do NOT cancel an in-progress draw when selectedAircraft
        // flips to null - the draw captured targetAircraftId at start time and
        // is independent of the live selection from then on.
        this.stateManager.subscribe('selectedAircraft', (next) => {
            this.updateDrawRouteButtonState(next);
        });
        this.updateDrawRouteButtonState(
            this.stateManager.getState().selectedAircraft
        );
    }

    /**
     * Show a "please select an aircraft" tooltip while hovering the Draw
     * Route button in its disabled state. The tooltip is position:fixed so
     * it isn't clipped by panel overflow/borders; we compute its location
     * from the button's viewport rect on each mouseenter.
     */
    private setupDrawRouteDisabledTooltip(): void {
        const wrapper = document.querySelector('.draw-route-btn-wrapper') as HTMLElement | null;
        const btn = document.getElementById('draw-route-btn') as HTMLButtonElement | null;
        const tooltip = document.querySelector('.draw-route-disabled-tooltip') as HTMLElement | null;
        if (!wrapper || !btn || !tooltip) return;

        const positionAndShow = () => {
            if (!btn.classList.contains('disabled')) {
                tooltip.style.display = 'none';
                return;
            }
            // Show first (offscreen) so we can measure the tooltip's size
            // before clamping it to the viewport.
            tooltip.style.display = 'block';
            tooltip.style.left = '-9999px';
            tooltip.style.top = '-9999px';

            const btnRect = btn.getBoundingClientRect();
            const tipRect = tooltip.getBoundingClientRect();
            const margin = 8;

            // Prefer centered under the button, then clamp horizontally so
            // the tooltip stays fully inside the viewport (the button lives
            // in a narrow left panel, so it would otherwise overhang the
            // browser's left edge).
            const centered = btnRect.left + btnRect.width / 2 - tipRect.width / 2;
            const maxLeft = window.innerWidth - tipRect.width - margin;
            const minLeft = margin;
            const left = Math.max(minLeft, Math.min(centered, maxLeft));

            // Flip above the button if placing it below would overflow the
            // viewport bottom.
            let top = btnRect.bottom + 6;
            if (top + tipRect.height + margin > window.innerHeight) {
                top = btnRect.top - tipRect.height - 6;
            }

            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
        };
        const hide = () => {
            tooltip.style.display = 'none';
        };

        const signal = this.teardownSignal;
        wrapper.addEventListener('mouseenter', positionAndShow, { signal });
        wrapper.addEventListener('mouseleave', hide, { signal });
        // If the viewport scrolls/resizes while the tooltip is visible,
        // reposition it so it stays anchored to the button.
        window.addEventListener('scroll', () => {
            if (tooltip.style.display === 'block') positionAndShow();
        }, { capture: true, signal });
        window.addEventListener('resize', () => {
            if (tooltip.style.display === 'block') positionAndShow();
        }, { signal });
    }

    /**
     * Enable/disable the Draw Route button based on whether an aircraft is
     * currently selected. Also sets a tooltip explaining the disabled state.
     *
     * While a draw is in progress the button shows "Stop Drawing Route" and
     * must stay enabled regardless of the live selection (the draw captured
     * its target at start time), so we skip updates in that state.
     */
    private updateDrawRouteButtonState(selectedAircraft: string | null): void {
        if (this.drawingMode) return;

        const btn = document.getElementById('draw-route-btn') as HTMLButtonElement | null;
        if (!btn) return;

        if (selectedAircraft) {
            btn.disabled = false;
            btn.title = `Draw a route for ${selectedAircraft}`;
            btn.classList.remove('disabled');
        } else {
            btn.disabled = true;
            btn.title = 'Select an aircraft first (click its icon on the map or in the traffic list) to draw a route';
            btn.classList.add('disabled');
        }
    }

    /**
     * Public entry point - toggles drawing mode.
     */
    public toggleDrawing(): void {
        if (this.drawingMode) {
            this.cancelDrawing();
        } else {
            this.startDrawingForSelectedAircraft();
        }
    }

    private getCurrentAltitudeUnit(): AltitudeUnit {
        const sel = document.getElementById('altitude-unit-select') as HTMLSelectElement | null;
        return (sel?.value as AltitudeUnit) || 'ft';
    }

    private getCurrentSpeedUnit(): SpeedUnit {
        const sel = document.getElementById('speed-unit-select') as HTMLSelectElement | null;
        return (sel?.value as SpeedUnit) || 'knots';
    }

    /**
     * Begin drawing a route for the currently selected aircraft.
     */
    private startDrawingForSelectedAircraft(): void {
        const selected = this.stateManager.getState().selectedAircraft;
        if (!selected) {
            alert(
                'Select an aircraft first (click its icon on the map or in the traffic list) before drawing a route.'
            );
            return;
        }

        this.targetAircraftId = selected;
        this.capturedAltUnit = this.getCurrentAltitudeUnit();
        this.capturedSpeedUnit = this.getCurrentSpeedUnit();
        this.drawingMode = true;
        this.routePoints = [];

        // Resolve the leader anchor (and its label) once: last existing
        // waypoint if the aircraft already has a route, otherwise the
        // aircraft's current position.
        const resolved = this.resolveLeaderAnchor(selected);
        this.leaderAnchor = resolved.anchor;
        this.leaderAnchorLabel = resolved.label;

        const drawBtn = document.getElementById('draw-route-btn');
        if (drawBtn) {
            drawBtn.textContent = 'Stop Drawing Route';
            drawBtn.classList.add('active');
        }

        this.showDrawingBanner(
            `Drawing route for ${this.targetAircraftId} (leader from ${this.leaderAnchorLabel}) - Click to add waypoints, right-click or Enter to finish, Esc to cancel`
        );
        this.enableMapDrawing();
        this.preview.updateDrawing(this.routePoints, this.leaderAnchor);

        logger.info(
            'RouteDrawingManager',
            `Started drawing route for ${this.targetAircraftId}; leader anchor = ${this.leaderAnchorLabel}`
        );
    }

    /**
     * Resolve the leader-line anchor and its human-readable source label in
     * one place: last existing waypoint if the aircraft already has a route,
     * else the aircraft's current position (label stays 'aircraft' even when
     * no position is available, so the banner reads sensibly).
     */
    private resolveLeaderAnchor(aircraftId: string): { anchor: DrawingPoint | null; label: string } {
        const route = this.app.getRouteData();
        if (
            route &&
            route.acid === aircraftId &&
            route.wplat &&
            route.wplon &&
            route.wplat.length > 0 &&
            route.wplat.length === route.wplon.length
        ) {
            const lastIdx = route.wplat.length - 1;
            return {
                anchor: { lat: route.wplat[lastIdx], lng: route.wplon[lastIdx] },
                label: 'last existing waypoint',
            };
        }

        const ac = this.stateManager.getAircraftById(aircraftId);
        if (ac) {
            return { anchor: { lat: ac.lat, lng: ac.lon }, label: 'aircraft' };
        }

        return { anchor: null, label: 'aircraft' };
    }

    /**
     * Stop drawing and clean up state. Called both on user cancel and on
     * successful submission of the constraints modal.
     */
    private stopDrawing(): void {
        this.drawingMode = false;
        this.routePoints = [];
        this.targetAircraftId = null;
        this.leaderAnchor = null;
        this.leaderAnchorLabel = 'aircraft';

        const drawBtn = document.getElementById('draw-route-btn');
        if (drawBtn) {
            drawBtn.textContent = 'Draw Route';
            drawBtn.classList.remove('active');
        }

        // Re-apply disabled state based on current selection.
        this.updateDrawRouteButtonState(
            this.stateManager.getState().selectedAircraft
        );

        this.hideDrawingBanner();
        this.disableMapDrawing();

        logger.debug('RouteDrawingManager', 'Stopped route drawing');
    }

    protected cancelDrawing(): void {
        logger.info('RouteDrawingManager', 'Route drawing cancelled');
        this.stopDrawing();
    }

    protected onDrawingEnabled(): void {
        this.preview.setup();
    }

    protected onDrawingDisabled(): void {
        this.preview.clear();
        this.preview.teardown();
    }

    protected onPointAdded(point: DrawingPoint): void {
        this.routePoints.push(point);

        this.showDrawingBanner(
            `Drawing route for ${this.targetAircraftId} (leader from ${this.leaderAnchorLabel}) - ${this.routePoints.length} waypoint(s) (right-click or Enter to finish, Esc to cancel)`
        );
        this.preview.updateDrawing(this.routePoints, this.leaderAnchor);

        logger.debug(
            'RouteDrawingManager',
            `Added waypoint ${this.routePoints.length}: ${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`
        );
    }

    protected onCursorMove(point: DrawingPoint): void {
        this.preview.updateCursor(point, this.routePoints, this.leaderAnchor);
    }

    protected finishDrawing(): void {
        if (this.routePoints.length < 1) {
            alert('Add at least 1 waypoint to create a route');
            return;
        }
        if (!this.targetAircraftId) return;

        this.modal.show(
            this.targetAircraftId,
            this.routePoints,
            this.capturedAltUnit,
            this.capturedSpeedUnit
        );
    }

}
