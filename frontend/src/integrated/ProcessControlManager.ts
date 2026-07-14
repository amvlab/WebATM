import type { ServerControlResponse } from '../data/types';
import { logger } from '../utils/Logger';
import type { ServerLogStreamManager } from './ServerLogStreamManager';

/**
 * Wires every Start / Stop / Restart / Kill control surface — the Server Log
 * toolbar and the Settings-modal controls, both tagged with data-bs-action —
 * to the integrated REST endpoints, and keeps the shared .bs-status indicators
 * in sync with the process state and the live BlueSky connection.
 * Integrated build only.
 */

const ACTIONS = ['start', 'stop', 'restart', 'kill'] as const;
type Action = (typeof ACTIONS)[number];

/**
 * Minimal view of ConnectionStatusService this manager needs: whether BlueSky
 * is currently connected (the same data-flow truth the header uses) plus a way
 * to be notified when it changes. Kept structural so it stays trivially
 * mockable.
 */
export interface ConnectionStateSource {
    isBlueSkyConnected(): boolean;
    subscribe(listener: () => void): () => void;
}

export class ProcessControlManager {
    /**
     * Auto-connect attempts after a start/restart. Each connect call waits ~10s
     * for BlueSky nodes server-side; the extra attempts cover a slow cold start.
     */
    private static readonly AUTO_CONNECT_ATTEMPTS = 3;

    /** Latest process state from the status probe. */
    private serverRunning = false;
    /** True while a lifecycle action owns the status text (suppresses reconcile). */
    private busy = false;

    /**
     * @param logTab          live server-log tab to surface after a (re)start
     * @param autoConnect     connects the WebATM proxy to the freshly-started
     *   BlueSky server (resolves true once confirmed), so the user never has to
     *   open Settings and click Connect
     * @param autoDisconnect  drops the proxy connection after a stop/kill
     * @param connectionState live BlueSky connection status (the same source
     *   the header reads), folded into the rendered status so the two
     *   indicators never contradict — e.g. after QUIT disconnects the proxy
     *   while the bundled server keeps running
     */
    constructor(
        private logTab: ServerLogStreamManager,
        private autoConnect: () => Promise<boolean>,
        private autoDisconnect: () => Promise<void>,
        private connectionState: ConnectionStateSource,
    ) {
        this.bind();
        this.connectionState.subscribe(() => this.onConnectionStateChanged());
        void this.refreshStatus();
    }

    private bind(): void {
        // One sweep binds every control surface: toolbar + Settings modal.
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
            // The proxy connection follows the server lifecycle automatically.
            if (action === 'start' || action === 'restart') {
                // Surface the live logs even on a failed start, so the error is
                // visible.
                this.logTab.activate();
                if (data.success) {
                    await this.runAutoConnect();
                }
            } else if ((action === 'stop' || action === 'kill') && data.success) {
                await this.runAutoDisconnect();
            }
        } catch (err) {
            logger.error('ProcessControlManager', `${action} failed`, err);
            this.setStatus(`${action} failed`);
        } finally {
            this.busy = false;
        }
    }

    /** Best-effort auto-connect to the just-started BlueSky server. */
    private async runAutoConnect(): Promise<void> {
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

    /** Best-effort auto-disconnect after the server is stopped/killed. */
    private async runAutoDisconnect(): Promise<void> {
        try {
            await this.autoDisconnect();
        } catch (err) {
            logger.error('ProcessControlManager', 'auto-disconnect failed', err);
        }
    }

    /**
     * A connection flip can mean the server went away or just stopped sending
     * data, so re-probe the process to keep the combined status accurate
     * (e.g. "running — not connected" after QUIT vs. "stopped" after a crash).
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
            this.renderStatus();
        } catch {
            // Leave the status as-is if the probe fails.
        }
    }

    /**
     * Render the settled status from the process state, folding in the live
     * BlueSky connection so this indicator never contradicts the header.
     */
    private renderStatus(): void {
        if (!this.serverRunning) {
            this.setStatus('stopped');
            return;
        }
        this.setStatus(
            this.connectionState.isBlueSkyConnected()
                ? 'running — connected'
                : 'running — not connected',
        );
    }

    private setStatus(text: string): void {
        // Mirror the status onto every surface so they never drift apart.
        document.querySelectorAll<HTMLElement>('.bs-status').forEach((el) => {
            el.textContent = text;
        });
    }
}
