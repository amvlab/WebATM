import type { ServerControlResponse } from '../data/types';
import { logger } from '../utils/Logger';
import type { ServerLogStreamManager } from './ServerLogStreamManager';

/**
 * Wires the Start / Stop / Restart / Kill buttons (injected by
 * ServerLogStreamManager) to the integrated REST endpoints. Integrated build
 * only.
 */

const ACTIONS = ['start', 'stop', 'restart', 'kill'] as const;
type Action = (typeof ACTIONS)[number];

/**
 * Minimal view of ConnectionStatusService this manager needs: whether BlueSky is
 * currently connected (the same data-flow truth the header uses) plus a way to
 * be notified when it changes. Kept structural so it stays trivially mockable.
 */
export interface ConnectionStateSource {
    isBlueSkyConnected(): boolean;
    subscribe(listener: () => void): () => void;
}

export class ProcessControlManager {
    /**
     * Auto-connect attempts after a start/restart. Each connect call waits ~10s
     * for BlueSky nodes server-side, covering the normal start-up window; the
     * extra attempts cover a slow cold start.
     */
    private static readonly AUTO_CONNECT_ATTEMPTS = 3;

    /** Latest process state from the status probe, used to render combined status. */
    private serverRunning = false;
    private serverPid: number | null = null;
    /** True while a lifecycle action owns the status text (suppresses reconcile). */
    private busy = false;

    /**
     * @param logTab         live server-log tab to surface after a (re)start
     * @param autoConnect    optional hook that connects the WebATM proxy to the
     *   freshly-started BlueSky server. Injected in the integrated build so the
     *   user doesn't have to open Settings and click Connect themselves; omitted
     *   (and thus skipped) otherwise. Resolves true once the connection is
     *   confirmed.
     * @param autoDisconnect optional hook that drops the proxy connection after
     *   the server is stopped/killed. Injected alongside autoConnect.
     * @param connectionState optional live BlueSky connection status (the same
     *   source the header reads). Injected in the integrated build so the
     *   server-control status reconciles with it and the two indicators can
     *   never contradict — e.g. after QUIT disconnects the proxy while the
     *   bundled server keeps running. Omitted in the default build.
     */
    constructor(
        private logTab: ServerLogStreamManager,
        private autoConnect?: () => Promise<boolean>,
        private autoDisconnect?: () => Promise<void>,
        private connectionState?: ConnectionStateSource,
    ) {
        this.bind();
        // Re-reconcile the control status whenever the live BlueSky connection
        // flips, so it tracks the header instead of only the last button press.
        this.connectionState?.subscribe(() => this.onConnectionStateChanged());
        void this.refreshStatus();
    }

    private bind(): void {
        // Bind every control surface at once — the Server Log toolbar and the
        // Settings-modal controls both tag their buttons with data-bs-action, so
        // a single sweep wires them all.
        document.querySelectorAll<HTMLElement>('[data-bs-action]').forEach((el) => {
            const action = el.dataset.bsAction;
            if (action && (ACTIONS as readonly string[]).includes(action)) {
                el.addEventListener('click', () => void this.control(action as Action));
            }
        });
    }

    private async control(action: Action): Promise<void> {
        // Mark busy so connection-status flips during the action don't clobber
        // the transient lifecycle status text mid-flight.
        this.busy = true;
        this.setStatus(`${action}…`);
        try {
            const res = await fetch(`/api/integrated/server/${action}`, { method: 'POST' });
            const data: ServerControlResponse = await res.json();
            this.setStatus(data.message || data.status || 'done');
            // Integrated flow: the proxy connection follows the server lifecycle
            // automatically, which is where this diverges from the default
            // build's manual connect/disconnect step.
            if (action === 'start' || action === 'restart') {
                // Surface the live logs (even on a failed start, so the error is
                // visible), then auto-connect to the freshly-started server.
                this.logTab.activate();
                if (data.success) {
                    await this.runAutoConnect();
                }
            } else if ((action === 'stop' || action === 'kill') && data.success) {
                // Server is going away — drop the proxy connection too.
                await this.runAutoDisconnect();
            }
        } catch (err) {
            logger.error('ProcessControlManager', `${action} failed`, err);
            this.setStatus(`${action} failed`);
        } finally {
            this.busy = false;
        }
    }

    /**
     * Best-effort auto-connect to the just-started BlueSky server. No-op when no
     * autoConnect hook was supplied (default build). Retries a few times since
     * the server needs a moment to accept connections after the process spawns.
     */
    private async runAutoConnect(): Promise<void> {
        if (!this.autoConnect) return;
        for (let attempt = 1; attempt <= ProcessControlManager.AUTO_CONNECT_ATTEMPTS; attempt++) {
            this.setStatus(attempt === 1 ? 'connecting…' : `connecting… (retry ${attempt - 1})`);
            try {
                if (await this.autoConnect()) {
                    this.setStatus('running — connected');
                    return;
                }
            } catch (err) {
                logger.error('ProcessControlManager', 'auto-connect attempt failed', err);
            }
        }
        this.setStatus('started — auto-connect failed (open Settings → Connect)');
    }

    /**
     * Best-effort auto-disconnect after the server is stopped/killed. No-op when
     * no autoDisconnect hook was supplied (default build).
     */
    private async runAutoDisconnect(): Promise<void> {
        if (!this.autoDisconnect) return;
        try {
            await this.autoDisconnect();
        } catch (err) {
            logger.error('ProcessControlManager', 'auto-disconnect failed', err);
        }
    }

    /**
     * Re-render the status when the live BlueSky connection flips. A flip can
     * mean the server went away or just stopped sending data, so re-probe the
     * process to keep the combined status accurate (e.g. "running — not
     * connected" after QUIT vs. "stopped" after a crash).
     */
    private onConnectionStateChanged(): void {
        if (this.busy) return; // a lifecycle action owns the status right now
        void this.refreshStatus();
    }

    private async refreshStatus(): Promise<void> {
        try {
            const res = await fetch('/api/integrated/server/status');
            const data = await res.json();
            this.serverRunning = !!data.running;
            this.serverPid = (data.pid ?? null) as number | null;
            this.renderStatus();
        } catch {
            // Leave the status as-is if the probe fails.
        }
    }

    /**
     * Render the settled status from the process state, folding in the live
     * BlueSky connection when it's available so this indicator can never
     * contradict the header. Without a connection source (default build) it
     * falls back to the plain process state.
     */
    private renderStatus(): void {
        if (!this.serverRunning) {
            this.setStatus('stopped');
            return;
        }
        if (!this.connectionState) {
            this.setStatus(`running (pid ${this.serverPid})`);
            return;
        }
        this.setStatus(
            this.connectionState.isBlueSkyConnected()
                ? 'running — connected'
                : 'running — not connected',
        );
    }

    private setStatus(text: string): void {
        // Mirror the status onto every surface (toolbar + Settings modal) so they
        // never drift apart.
        document.querySelectorAll<HTMLElement>('.bs-status').forEach((el) => {
            el.textContent = text;
        });
    }
}
