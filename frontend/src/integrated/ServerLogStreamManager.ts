import type { Socket } from 'socket.io-client';
import type { ServerLogBatch, ServerLogLine } from '../data/types';
import { logger } from '../utils/Logger';

/**
 * Live server-log tab (integrated build only).
 *
 * Adds a third tab — "Server Log" — next to the existing Echo / Output Log
 * tabs and renders the live, in-order stdout/stderr of the `bluesky --headless`
 * process tree pushed over the `server_log` Socket.IO event. This is distinct
 * from the file-polling "Output Log" tab (LogStreamManager): this one streams a
 * running process, that one browses output files on disk.
 *
 * The tab button and pane are injected at runtime so the core `index.html`
 * carries no integrated-specific markup (preserving build-time exclusion).
 */

// Shared header controls owned by the core echo/output-log tabs. Hidden while
// the Server Log tab is active; the core tab handlers restore them on switch.
const SHARED_CONTROL_IDS = [
    'clear-echo',
    'refresh-output-files',
    'clear-log-stream',
    'stop-log-stream',
    'log-stream-filename',
];

export class ServerLogStreamManager {
    private socket: Socket | null;
    private tabBtn: HTMLButtonElement | null = null;
    private container: HTMLElement | null = null;
    private output: HTMLElement | null = null;
    private echoOutput: HTMLElement | null = null;
    private outputLogContainer: HTMLElement | null = null;
    private echoTabBtn: HTMLElement | null = null;
    private logStreamTabBtn: HTMLElement | null = null;

    private static readonly MAX_LINES = 2000;

    private items: ServerLogLine[] = [];
    private seqSet = new Set<number>();
    private historyRequested = false;

    constructor(socket: Socket | null) {
        this.socket = socket;
        this.buildDom();
        this.bindSocket();
    }

    private buildDom(): void {
        const tabBar = document.querySelector('.echo-tab-bar');
        const echoSection = document.querySelector('.echo-section');
        this.echoOutput = document.getElementById('echo-output');
        this.outputLogContainer = document.getElementById('output-log-container');
        this.echoTabBtn = document.getElementById('echo-tab-btn');
        this.logStreamTabBtn = document.getElementById('log-stream-tab-btn');

        if (!tabBar || !echoSection) {
            logger.warn('ServerLogStreamManager', 'Echo section not found; server-log tab disabled');
            return;
        }

        // Tab button
        const btn = document.createElement('button');
        btn.id = 'server-log-tab-btn';
        btn.className = 'echo-tab';
        btn.textContent = 'Server Log';
        btn.addEventListener('click', () => this.activate());
        tabBar.appendChild(btn);
        this.tabBtn = btn;

        // Container: toolbar + output. Reuses the core .log-stream-output and
        // .console-btn styling; only the toolbar layout is inlined.
        const container = document.createElement('div');
        container.id = 'server-log-container';
        container.style.display = 'none';
        container.style.flexDirection = 'column';
        container.style.flex = '1';
        container.style.overflow = 'hidden';

        const toolbar = document.createElement('div');
        toolbar.id = 'server-log-toolbar';
        toolbar.style.display = 'flex';
        toolbar.style.alignItems = 'center';
        toolbar.style.gap = '4px';
        toolbar.style.padding = '4px 8px';
        toolbar.style.borderBottom = '1px solid #404040';
        // The action buttons / status span carry generic data-bs-action and
        // .bs-status hooks (alongside their ids) so ProcessControlManager can
        // drive this toolbar and the Settings-modal controls uniformly.
        toolbar.innerHTML = `
            <button id="bs-start" data-bs-action="start" class="console-btn">Start</button>
            <button id="bs-stop" data-bs-action="stop" class="console-btn">Stop</button>
            <button id="bs-restart" data-bs-action="restart" class="console-btn">Restart</button>
            <button id="bs-kill" data-bs-action="kill" class="console-btn">Kill</button>
            <span id="bs-status" class="bs-status" style="margin-left:8px;color:#888;">unknown</span>
            <button id="bs-clear" class="console-btn" style="margin-left:auto;">Clear</button>
        `;

        const output = document.createElement('div');
        output.id = 'server-log-output';
        output.className = 'log-stream-output';

        container.appendChild(toolbar);
        container.appendChild(output);
        echoSection.appendChild(container);

        this.container = container;
        this.output = output;

        toolbar.querySelector('#bs-clear')?.addEventListener('click', () => this.clear());

        // When the user switches to either core tab, hide our pane. The core
        // handlers restore their own pane and shared controls.
        this.echoTabBtn?.addEventListener('click', () => this.deactivate());
        this.logStreamTabBtn?.addEventListener('click', () => this.deactivate());
    }

    private bindSocket(): void {
        if (!this.socket) {
            logger.warn('ServerLogStreamManager', 'No socket; live server logs unavailable');
            return;
        }
        this.socket.on('server_log', (data: ServerLogBatch) => {
            if (data && Array.isArray(data.lines)) {
                this.ingest(data.lines);
            }
        });
    }

    /** Switch to the Server Log tab (also called by ProcessControlManager). */
    public activate(): void {
        if (!this.container) return;
        if (this.echoOutput) this.echoOutput.style.display = 'none';
        if (this.outputLogContainer) this.outputLogContainer.style.display = 'none';
        this.container.style.display = 'flex';

        this.tabBtn?.classList.add('active');
        this.echoTabBtn?.classList.remove('active');
        this.logStreamTabBtn?.classList.remove('active');

        for (const id of SHARED_CONTROL_IDS) {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        }

        if (!this.historyRequested) {
            this.historyRequested = true;
            this.socket?.emit('request_log_history');
        }
    }

    private deactivate(): void {
        if (this.container) this.container.style.display = 'none';
        this.tabBtn?.classList.remove('active');
    }

    private ingest(incoming: ServerLogLine[]): void {
        if (!this.output) return;

        const fresh = incoming.filter((it) => !this.seqSet.has(it.seq));
        if (fresh.length === 0) return;
        for (const it of fresh) this.seqSet.add(it.seq);

        const nearBottom = this.isNearBottom();
        const lastSeq = this.items.length ? this.items[this.items.length - 1].seq : 0;
        const pureAppend = fresh.every((it) => it.seq > lastSeq);

        if (pureAppend) {
            // Fast path: ordered live lines — append incrementally.
            fresh.sort((a, b) => a.seq - b.seq);
            this.items.push(...fresh);
            const frag = document.createDocumentFragment();
            for (const it of fresh) frag.appendChild(this.lineEl(it.line));
            this.output.appendChild(frag);
            this.trimFront();
        } else {
            // Out-of-order (history replay): merge, sort, cap, re-render once.
            this.items.push(...fresh);
            this.items.sort((a, b) => a.seq - b.seq);
            if (this.items.length > ServerLogStreamManager.MAX_LINES) {
                this.items = this.items.slice(this.items.length - ServerLogStreamManager.MAX_LINES);
            }
            this.seqSet = new Set(this.items.map((it) => it.seq));
            this.fullRender();
        }

        if (nearBottom) this.output.scrollTop = this.output.scrollHeight;
    }

    private lineEl(text: string): HTMLElement {
        const el = document.createElement('div');
        el.className = 'log-stream-line';
        el.textContent = text;
        return el;
    }

    private fullRender(): void {
        if (!this.output) return;
        const frag = document.createDocumentFragment();
        for (const it of this.items) frag.appendChild(this.lineEl(it.line));
        this.output.replaceChildren(frag);
    }

    private trimFront(): void {
        if (!this.output) return;
        while (this.items.length > ServerLogStreamManager.MAX_LINES) {
            const dropped = this.items.shift();
            if (dropped) this.seqSet.delete(dropped.seq);
            if (this.output.firstChild) this.output.removeChild(this.output.firstChild);
        }
    }

    private isNearBottom(): boolean {
        if (!this.output) return true;
        return this.output.scrollHeight - this.output.scrollTop - this.output.clientHeight < 40;
    }

    public clear(): void {
        this.items = [];
        this.seqSet.clear();
        if (this.output) this.output.replaceChildren();
    }
}
