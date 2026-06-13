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

export class ProcessControlManager {
    /**
     * Auto-connect attempts after a start/restart. Each connect call waits ~10s
     * for BlueSky nodes server-side, covering the normal start-up window; the
     * extra attempts cover a slow cold start.
     */
    private static readonly AUTO_CONNECT_ATTEMPTS = 3;

    /**
     * @param logTab         live server-log tab to surface after a (re)start
     * @param autoConnect    optional hook that connects the WebATM proxy to the
     *   freshly-started BlueSky server. Injected in the integrated build so the
     *   user doesn't have to open Settings and click Connect themselves; omitted
     *   (and thus skipped) otherwise. Resolves true once the connection is
     *   confirmed.
     * @param autoDisconnect optional hook that drops the proxy connection after
     *   the server is stopped/killed. Injected alongside autoConnect.
     */
    constructor(
        private logTab: ServerLogStreamManager,
        private autoConnect?: () => Promise<boolean>,
        private autoDisconnect?: () => Promise<void>,
    ) {
        this.bind();
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

    private async refreshStatus(): Promise<void> {
        try {
            const res = await fetch('/api/integrated/server/status');
            const data = await res.json();
            this.setStatus(data.running ? `running (pid ${data.pid})` : 'stopped');
        } catch {
            // Leave the status as-is if the probe fails.
        }
    }

    private setStatus(text: string): void {
        // Mirror the status onto every surface (toolbar + Settings modal) so they
        // never drift apart.
        document.querySelectorAll<HTMLElement>('.bs-status').forEach((el) => {
            el.textContent = text;
        });
    }
}
