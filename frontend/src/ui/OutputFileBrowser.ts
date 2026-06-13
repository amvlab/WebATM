import { logger } from '../utils/Logger';

interface OutputFile {
    filename: string;
    size: number;
    modified: number;
    type: 'file' | 'folder';
}

interface Breadcrumb {
    name: string;
    path: string;
}

interface BrowseResponse {
    success: boolean;
    file_type: string;
    files: OutputFile[];
    current_path: string;
    breadcrumbs: Breadcrumb[];
    base_path: string;
    error?: string;
}

interface FileStatusResponse {
    configured: boolean;
    base_path?: string;
    derived_paths?: {
        scenario: string;
        plugins: string;
        settings: string;
        output: string;
    };
    path_exists?: boolean;
    path_writable?: boolean;
}

export class OutputFileBrowser {
    private currentPath: string = '';
    private isConfigured: boolean = false;
    private fileListElement: HTMLElement | null = null;
    private notConfiguredElement: HTMLElement | null = null;
    private browserElement: HTMLElement | null = null;
    private searchInput: HTMLElement | null = null;
    private isInitialized = false;

    private lastFiles: OutputFile[] = [];
    private lastBreadcrumbs: Breadcrumb[] = [];
    private searchFilter: string = '';

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
        this.fileListElement = document.getElementById('output-file-list');
        this.notConfiguredElement = document.getElementById('output-not-configured');
        this.browserElement = document.getElementById('output-file-browser');
        this.searchInput = document.getElementById('output-search-input');

        if (this.searchInput) {
            this.searchInput.addEventListener('input', (e) => {
                this.searchFilter = (e.target as HTMLInputElement).value.toLowerCase();
                this.renderFileList(this.lastFiles, this.lastBreadcrumbs);
            });
        }

        this.isInitialized = true;
        logger.debug('OutputFileBrowser', 'Initialized');
    }

    public async show(): Promise<void> {
        await this.checkConfiguration();

        if (this.isConfigured) {
            if (this.notConfiguredElement) this.notConfiguredElement.style.display = 'none';
            if (this.browserElement) this.browserElement.style.display = '';
            this.currentPath = '';
            this.searchFilter = '';
            if (this.searchInput) (this.searchInput as HTMLInputElement).value = '';
            await this.refreshFileList();
        } else {
            if (this.notConfiguredElement) this.notConfiguredElement.style.display = '';
            if (this.browserElement) this.browserElement.style.display = '';
            if (this.fileListElement) this.fileListElement.innerHTML = '';
        }
    }

    private async checkConfiguration(): Promise<void> {
        try {
            const response = await fetch('/api/bluesky/filestatus');
            const result: FileStatusResponse = await response.json();
            this.isConfigured = result.configured === true && result.path_exists === true;
        } catch (error) {
            logger.error('OutputFileBrowser', 'Failed to check configuration:', error);
            this.isConfigured = false;
        }
    }

    public async refreshFileList(): Promise<void> {
        if (!this.isConfigured || !this.fileListElement) return;

        try {
            const url = this.currentPath
                ? `/api/bluesky/browse/output/${encodeURIComponent(this.currentPath)}`
                : '/api/bluesky/browse/output';

            const response = await fetch(url);
            const result: BrowseResponse = await response.json();

            if (result.success) {
                this.lastFiles = result.files;
                this.lastBreadcrumbs = result.breadcrumbs;
                this.renderFileList(result.files, result.breadcrumbs);
            } else {
                this.fileListElement.innerHTML =
                    '<div class="output-browser-message output-browser-error">Error loading files</div>';
            }
        } catch (error) {
            logger.error('OutputFileBrowser', 'Failed to load file list:', error);
            if (this.fileListElement) {
                this.fileListElement.innerHTML =
                    '<div class="output-browser-message output-browser-error">Failed to load files</div>';
            }
        }
    }

    private renderFileList(files: OutputFile[], breadcrumbs?: Breadcrumb[]): void {
        if (!this.fileListElement) return;

        let content = '';

        if (breadcrumbs && breadcrumbs.length > 1) {
            const breadcrumbItems = breadcrumbs.map((crumb, index) => {
                const isLast = index === breadcrumbs.length - 1;
                const clickHandler = isLast
                    ? ''
                    : `onclick="outputFileBrowser.navigateToPath('${crumb.path}')"`;
                const cls = isLast ? 'output-crumb-active' : 'output-crumb-link';
                return `<span class="${cls}" ${clickHandler}>${crumb.name}</span>`;
            }).join(' <span class="output-crumb-sep">/</span> ');

            content += `<div class="output-breadcrumbs">${breadcrumbItems}</div>`;
        }

        // Sort: folders first (alphabetical), then files by most recently modified
        const folders = files
            .filter(f => f.type === 'folder')
            .sort((a, b) => a.filename.localeCompare(b.filename));
        const regularFiles = files
            .filter(f => f.type === 'file')
            .sort((a, b) => b.modified - a.modified);

        let sorted = [...folders, ...regularFiles];

        // Apply search filter
        if (this.searchFilter) {
            sorted = sorted.filter(f =>
                f.filename.toLowerCase().includes(this.searchFilter)
            );
        }

        if (sorted.length === 0) {
            const msg = this.searchFilter ? 'No matching files' : 'No output files found';
            content += `<div class="output-browser-message">${msg}</div>`;
            this.fileListElement.innerHTML = content;
            return;
        }

        const fileItems = sorted.map(file => {
            const modifiedDate = new Date(file.modified * 1000).toLocaleDateString();
            const modifiedTime = new Date(file.modified * 1000).toLocaleTimeString();
            const isFolder = file.type === 'folder';
            const sizeText = isFolder ? '' : this.formatFileSize(file.size);
            const filePath = this.currentPath
                ? `${this.currentPath}/${file.filename}`
                : file.filename;

            if (isFolder) {
                return `<div class="output-file-row output-folder-row" onclick="outputFileBrowser.navigateToFolder('${file.filename}')">
                    <span class="output-file-icon">📁</span>
                    <span class="output-file-name">${file.filename}</span>
                </div>`;
            }

            return `<div class="output-file-row">
                <span class="output-file-icon">📄</span>
                <span class="output-file-name">${file.filename}</span>
                <span class="output-file-meta">${sizeText} &bull; ${modifiedDate} ${modifiedTime}</span>
                <span class="output-file-actions">
                    <button class="console-btn" onclick="outputFileBrowser.streamFile('${filePath}')">▶ Stream</button>
                    <button class="console-btn" onclick="outputFileBrowser.downloadFile('${filePath}')">⬇ Download</button>
                </span>
            </div>`;
        }).join('');

        content += fileItems;
        this.fileListElement.innerHTML = content;
    }

    private formatFileSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    public async navigateToFolder(folderName: string): Promise<void> {
        this.currentPath = this.currentPath
            ? `${this.currentPath}/${folderName}`
            : folderName;
        this.searchFilter = '';
        if (this.searchInput) (this.searchInput as HTMLInputElement).value = '';
        await this.refreshFileList();
    }

    public async navigateToPath(path: string): Promise<void> {
        this.currentPath = path;
        this.searchFilter = '';
        if (this.searchInput) (this.searchInput as HTMLInputElement).value = '';
        await this.refreshFileList();
    }

    public streamFile(filepath: string): void {
        window.logStreamManager?.startStreaming(filepath);
    }

    public downloadFile(filepath: string): void {
        window.logStreamManager?.downloadFile(filepath);
    }
}

export const outputFileBrowser = new OutputFileBrowser();

// Make it globally available for onclick handlers (typed in types/globals.d.ts)
window.outputFileBrowser = outputFileBrowser;
