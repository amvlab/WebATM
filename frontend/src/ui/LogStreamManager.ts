import { logger } from '../utils/Logger';

interface StreamContentResponse {
    success: boolean;
    content: string;
    offset: number;
    total_size: number;
    filename: string;
    error?: string;
}

export class LogStreamManager {
    private logStreamOutput: HTMLElement | null = null;
    private echoOutput: HTMLElement | null = null;
    private outputLogContainer: HTMLElement | null = null;
    private fileBrowserElement: HTMLElement | null = null;
    private echoTabBtn: HTMLElement | null = null;
    private logStreamTabBtn: HTMLElement | null = null;
    private filenameDisplay: HTMLElement | null = null;
    private clearEchoBtn: HTMLElement | null = null;
    private refreshBtn: HTMLElement | null = null;
    private clearStreamBtn: HTMLElement | null = null;
    private stopBtn: HTMLElement | null = null;

    // Search elements
    private searchBar: HTMLElement | null = null;
    private searchInput: HTMLInputElement | null = null;
    private searchCount: HTMLElement | null = null;
    private searchPrevBtn: HTMLElement | null = null;
    private searchNextBtn: HTMLElement | null = null;
    private searchCloseBtn: HTMLElement | null = null;

    private pollingInterval: ReturnType<typeof setInterval> | null = null;
    private currentFilepath: string = '';
    private currentOffset: number = 0;
    private isStreaming: boolean = false;
    private maxLines: number = 1000;
    private pollIntervalMs: number = 2000;
    private isInitialized = false;

    // Search state
    private searchMatches: HTMLElement[] = [];
    private currentMatchIndex: number = -1;
    private searchTerm: string = '';
    private searchDebounce: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        this.init();
    }

    private init(): void {
        if (this.isInitialized) return;

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.initializeElements());
        } else {
            this.initializeElements();
        }
    }

    private initializeElements(): void {
        this.logStreamOutput = document.getElementById('log-stream-output');
        this.echoOutput = document.getElementById('echo-output');
        this.outputLogContainer = document.getElementById('output-log-container');
        this.fileBrowserElement = document.getElementById('output-file-browser');
        this.echoTabBtn = document.getElementById('echo-tab-btn');
        this.logStreamTabBtn = document.getElementById('log-stream-tab-btn');
        this.filenameDisplay = document.getElementById('log-stream-filename');
        this.clearEchoBtn = document.getElementById('clear-echo');
        this.refreshBtn = document.getElementById('refresh-output-files');
        this.clearStreamBtn = document.getElementById('clear-log-stream');
        this.stopBtn = document.getElementById('stop-log-stream');

        this.searchBar = document.getElementById('log-search-bar');
        this.searchInput = document.getElementById('log-search-input') as HTMLInputElement;
        this.searchCount = document.getElementById('log-search-count');
        this.searchPrevBtn = document.getElementById('log-search-prev');
        this.searchNextBtn = document.getElementById('log-search-next');
        this.searchCloseBtn = document.getElementById('log-search-close');

        this.setupEventListeners();
        this.isInitialized = true;
        logger.debug('LogStreamManager', 'Initialized');
    }

    private setupEventListeners(): void {
        if (this.echoTabBtn) {
            this.echoTabBtn.addEventListener('click', () => this.switchToEchoView());
        }
        if (this.logStreamTabBtn) {
            this.logStreamTabBtn.addEventListener('click', () => this.switchToLogView());
        }
        if (this.refreshBtn) {
            this.refreshBtn.addEventListener('click', () => {
                window.outputFileBrowser?.refreshFileList();
            });
        }
        if (this.clearStreamBtn) {
            this.clearStreamBtn.addEventListener('click', () => {
                if (this.logStreamOutput) this.logStreamOutput.innerHTML = '';
                this.clearSearch();
            });
        }
        if (this.stopBtn) {
            this.stopBtn.addEventListener('click', () => this.stopStreaming());
        }

        // Search controls
        if (this.searchInput) {
            this.searchInput.addEventListener('input', () => {
                if (this.searchDebounce) clearTimeout(this.searchDebounce);
                this.searchDebounce = setTimeout(() => this.performSearch(), 200);
            });
            this.searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (e.shiftKey) {
                        this.prevMatch();
                    } else {
                        this.nextMatch();
                    }
                }
                if (e.key === 'Escape') {
                    this.closeSearch();
                }
            });
        }
        if (this.searchPrevBtn) {
            this.searchPrevBtn.addEventListener('click', () => this.prevMatch());
        }
        if (this.searchNextBtn) {
            this.searchNextBtn.addEventListener('click', () => this.nextMatch());
        }
        if (this.searchCloseBtn) {
            this.searchCloseBtn.addEventListener('click', () => this.closeSearch());
        }

        // Ctrl+F to open search when streaming
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                if (this.isStreaming && this.logStreamTabBtn?.classList.contains('active')) {
                    e.preventDefault();
                    this.openSearch();
                }
            }
        });
    }

    public async startStreaming(filepath: string): Promise<void> {
        this.stopStreaming();

        this.currentFilepath = filepath;
        this.currentOffset = 0;
        this.isStreaming = true;

        if (this.logStreamOutput) {
            this.logStreamOutput.innerHTML = '';
        }

        this.showStreamView();
        this.updateControls();

        await this.fetchContent(true);

        this.pollingInterval = setInterval(() => {
            this.fetchContent(false);
        }, this.pollIntervalMs);

        logger.info('LogStreamManager', `Streaming: ${filepath}`);
    }

    public stopStreaming(): void {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
        this.isStreaming = false;
        this.currentFilepath = '';
        this.currentOffset = 0;
        this.closeSearch();
        this.updateControls();
        this.showBrowserView();
    }

    private async fetchContent(isInitial: boolean): Promise<void> {
        if (!this.currentFilepath) return;

        try {
            const encodedPath = encodeURIComponent(this.currentFilepath);
            let url: string;

            if (isInitial) {
                url = `/api/bluesky/output/content/${encodedPath}?lines=50`;
            } else {
                url = `/api/bluesky/output/content/${encodedPath}?offset=${this.currentOffset}`;
            }

            const response = await fetch(url);
            const result: StreamContentResponse = await response.json();

            if (result.success) {
                this.currentOffset = result.offset;
                if (result.content) {
                    this.appendContent(result.content, isInitial);
                }
            } else {
                logger.warn('LogStreamManager', `Stream error: ${result.error}`);
                if (result.error === 'File not found') {
                    this.stopStreaming();
                }
            }
        } catch (error) {
            logger.error('LogStreamManager', 'Fetch error:', error);
        }
    }

    private appendContent(text: string, replace: boolean = false): void {
        if (!this.logStreamOutput) return;

        if (replace) {
            this.logStreamOutput.innerHTML = '';
        }

        const lines = text.split('\n');
        const fragment = document.createDocumentFragment();

        for (const line of lines) {
            const lineEl = document.createElement('div');
            lineEl.className = 'log-stream-line';
            lineEl.textContent = line;
            fragment.appendChild(lineEl);
        }

        this.logStreamOutput.appendChild(fragment);
        this.limitLines();
        this.logStreamOutput.scrollTop = this.logStreamOutput.scrollHeight;
    }

    private limitLines(): void {
        if (!this.logStreamOutput) return;

        while (this.logStreamOutput.children.length > this.maxLines) {
            this.logStreamOutput.removeChild(this.logStreamOutput.firstChild!);
        }
    }

    // --- Search ---

    private openSearch(): void {
        if (this.searchBar) {
            this.searchBar.style.display = 'flex';
            this.searchInput?.focus();
            this.searchInput?.select();
        }
    }

    private closeSearch(): void {
        if (this.searchBar) this.searchBar.style.display = 'none';
        this.clearSearch();
        if (this.searchInput) this.searchInput.value = '';
    }

    private clearSearch(): void {
        this.searchMatches.forEach(el => {
            el.classList.remove('log-search-highlight', 'active');
            // Restore original text (remove <mark> wrappers)
            if (el.querySelector('mark')) {
                // Reading textContent flattens the <mark> children; writing it
                // back replaces them with a single plain-text node.
                const plainText = el.textContent;
                el.textContent = plainText;
            }
        });
        this.searchMatches = [];
        this.currentMatchIndex = -1;
        this.searchTerm = '';
        if (this.searchCount) this.searchCount.textContent = '';
    }

    private performSearch(): void {
        if (!this.logStreamOutput || !this.searchInput) return;

        // Clear previous highlights by restoring textContent
        const highlighted = this.logStreamOutput.querySelectorAll('.log-search-highlight');
        highlighted.forEach(el => {
            el.classList.remove('log-search-highlight', 'active');
            if (el.querySelector('mark')) {
                // Reading textContent flattens the <mark> children; writing it
                // back replaces them with a single plain-text node.
                const plainText = el.textContent;
                el.textContent = plainText;
            }
        });

        this.searchMatches = [];
        this.currentMatchIndex = -1;
        this.searchTerm = this.searchInput.value.toLowerCase();

        if (!this.searchTerm) {
            if (this.searchCount) this.searchCount.textContent = '';
            return;
        }

        const lines = this.logStreamOutput.querySelectorAll('.log-stream-line');
        lines.forEach(line => {
            const el = line as HTMLElement;
            const text = el.textContent || '';
            if (text.toLowerCase().includes(this.searchTerm)) {
                el.classList.add('log-search-highlight');
                this.searchMatches.push(el);
            }
        });

        if (this.searchMatches.length > 0) {
            this.currentMatchIndex = 0;
            this.highlightCurrent();
        }

        this.updateSearchCount();
    }

    private highlightCurrent(): void {
        this.searchMatches.forEach(el => el.classList.remove('active'));

        if (this.currentMatchIndex >= 0 && this.currentMatchIndex < this.searchMatches.length) {
            const current = this.searchMatches[this.currentMatchIndex];
            current.classList.add('active');
            current.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }

    private updateSearchCount(): void {
        if (!this.searchCount) return;

        if (this.searchMatches.length === 0 && this.searchTerm) {
            this.searchCount.textContent = 'No matches';
        } else if (this.searchMatches.length > 0) {
            this.searchCount.textContent = `${this.currentMatchIndex + 1}/${this.searchMatches.length}`;
        } else {
            this.searchCount.textContent = '';
        }
    }

    private nextMatch(): void {
        if (this.searchMatches.length === 0) return;
        this.currentMatchIndex = (this.currentMatchIndex + 1) % this.searchMatches.length;
        this.highlightCurrent();
        this.updateSearchCount();
    }

    private prevMatch(): void {
        if (this.searchMatches.length === 0) return;
        this.currentMatchIndex = (this.currentMatchIndex - 1 + this.searchMatches.length) % this.searchMatches.length;
        this.highlightCurrent();
        this.updateSearchCount();
    }

    // --- View switching ---

    private showStreamView(): void {
        if (this.fileBrowserElement) this.fileBrowserElement.style.display = 'none';
        if (this.logStreamOutput) this.logStreamOutput.style.display = '';
        if (this.refreshBtn) this.refreshBtn.style.display = 'none';
        if (this.clearStreamBtn) this.clearStreamBtn.style.display = '';
    }

    private showBrowserView(): void {
        if (this.logStreamOutput) this.logStreamOutput.style.display = 'none';
        if (this.fileBrowserElement) this.fileBrowserElement.style.display = '';
        if (this.refreshBtn) this.refreshBtn.style.display = '';
        if (this.clearStreamBtn) this.clearStreamBtn.style.display = 'none';
    }

    public async switchToLogView(): Promise<void> {
        if (this.echoOutput) this.echoOutput.style.display = 'none';
        if (this.outputLogContainer) this.outputLogContainer.style.display = 'flex';
        if (this.echoTabBtn) this.echoTabBtn.classList.remove('active');
        if (this.logStreamTabBtn) this.logStreamTabBtn.classList.add('active');
        if (this.clearEchoBtn) this.clearEchoBtn.style.display = 'none';

        if (!this.isStreaming) {
            this.showBrowserView();
            await window.outputFileBrowser?.show();
        } else {
            this.showStreamView();
        }

        this.updateControls();
    }

    public switchToEchoView(): void {
        if (this.echoOutput) this.echoOutput.style.display = '';
        if (this.outputLogContainer) this.outputLogContainer.style.display = 'none';
        if (this.echoTabBtn) this.echoTabBtn.classList.add('active');
        if (this.logStreamTabBtn) this.logStreamTabBtn.classList.remove('active');
        if (this.clearEchoBtn) this.clearEchoBtn.style.display = '';
        if (this.refreshBtn) this.refreshBtn.style.display = 'none';
        if (this.clearStreamBtn) this.clearStreamBtn.style.display = 'none';
        if (this.stopBtn) this.stopBtn.style.display = 'none';
        if (this.filenameDisplay) this.filenameDisplay.style.display = 'none';
        this.closeSearch();
    }

    private updateControls(): void {
        if (this.filenameDisplay) {
            if (this.isStreaming && this.currentFilepath) {
                const filename = this.currentFilepath.split('/').pop() || this.currentFilepath;
                this.filenameDisplay.textContent = filename;
                this.filenameDisplay.style.display = '';
            } else {
                this.filenameDisplay.style.display = 'none';
            }
        }

        if (this.stopBtn) {
            const isLogView = this.logStreamTabBtn?.classList.contains('active');
            this.stopBtn.style.display = this.isStreaming && isLogView ? '' : 'none';
        }
    }

    public downloadFile(filepath: string): void {
        const encodedPath = encodeURIComponent(filepath);
        const a = document.createElement('a');
        a.href = `/api/bluesky/output/download/${encodedPath}`;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    public getIsStreaming(): boolean {
        return this.isStreaming;
    }
}

export const logStreamManager = new LogStreamManager();

// Make it globally available for onclick handlers (typed in types/globals.d.ts)
window.logStreamManager = logStreamManager;
