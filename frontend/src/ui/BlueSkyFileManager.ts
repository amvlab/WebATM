import { logger } from '../utils/Logger';
import { storage } from '../utils/StorageManager';
import { modalManager } from './ModalManager';
import { onDOMReady, setVisible, setText, escapeHtml } from '../utils/dom';

interface BlueSkyFileStatus {
    configured: boolean;
    base_path?: string;
    derived_paths?: {
        scenario: string;
        plugins: string;
        settings: string;
        output: string;
    };
}

interface UploadedFile {
    filename: string;
    size: number;
    modified: number;
    type: 'file' | 'folder';
}

interface BrowseDirectoryResponse {
    success: boolean;
    file_type: string;
    files: UploadedFile[];
    current_path: string;
    breadcrumbs: Breadcrumb[];
    base_path: string;
}

interface Breadcrumb {
    name: string;
    path: string;
}

interface UploadResponse {
    success: boolean;
    // Name the backend stored the file under (sanitization/auto-rename can
    // change it from the uploaded name).
    filename?: string;
    error?: string;
}

/**
 * BlueSky File Manager
 * Handles file uploads for scenarios, plugins, and settings files
 */
export class BlueSkyFileManager {
    private static readonly BASE_PATH_KEY = 'bluesky-base-path';

    // Accepted upload extension per file type; drives the file picker's
    // `accept` filter and a pre-upload check (the backend owns the real rules).
    private fileExtensions: Record<string, string> = {
        scenario: '.scn',
        plugins: '.py',
        settings: '.cfg'
    };

    private isConfigured: boolean = false;
    // Integrated build only: hides the manual "BlueSky Base Directory"
    // controls (the backend wires the paths itself). See enableIntegratedMode().
    private integratedMode: boolean = false;
    // Pending auto-clear timeout of the last status toast, if any.
    private statusClearTimer: ReturnType<typeof setTimeout> | null = null;
    // Pending hide timeout of the upload progress bar, if any.
    private progressHideTimer: ReturnType<typeof setTimeout> | null = null;
    private currentPaths: Record<string, string> = {
        scenario: '',
        plugins: '',
        settings: ''
    };

    constructor() {
        this.init();
    }

    private init(): void {
        onDOMReady(() => this.initializeFileManager());
    }

    private initializeFileManager(): void {
        this.setupEventHandlers();
        this.loadSavedBasePath();
        this.checkCurrentStatus();
        this.updateFileInputAccept();
    }

    private setupEventHandlers(): void {
        const configureBtn = document.getElementById('configure-base-path-btn-settings');
        configureBtn?.addEventListener('click', () => this.configureBasePath());

        const fileTypeSelect = document.getElementById('file-type-select') as HTMLSelectElement;
        fileTypeSelect?.addEventListener('change', () => this.updateFileInputAccept());

        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        const dropZone = document.getElementById('file-drop-zone');

        fileInput?.addEventListener('change', () => this.handleFileSelection());
        dropZone?.addEventListener('click', () => fileInput?.click());

        // Drag and drop; dragleave/dragend clear the highlight when a drag
        // leaves without dropping.
        dropZone?.addEventListener('dragover', (e) => this.handleDragOver(e));
        dropZone?.addEventListener('dragleave', () => this.clearDropHighlight());
        dropZone?.addEventListener('dragend', () => this.clearDropHighlight());
        dropZone?.addEventListener('drop', (e) => this.handleDrop(e));

        const uploadBtn = document.getElementById('upload-file-btn');
        uploadBtn?.addEventListener('click', () => this.uploadFile());

        const uploadAndRunBtn = document.getElementById('upload-and-run-scenario-btn');
        uploadAndRunBtn?.addEventListener('click', () => this.uploadAndRunScenario());

        const refreshBtn = document.getElementById('refresh-files-btn');
        const viewFileTypeSelect = document.getElementById('view-file-type-select') as HTMLSelectElement;
        
        refreshBtn?.addEventListener('click', () => this.refreshFileList());
        viewFileTypeSelect?.addEventListener('change', () => {
            // Reset current path when changing file types
            const fileType = viewFileTypeSelect.value;
            this.currentPaths[fileType] = '';
            this.refreshFileList();
        });

        const closeFooterBtn = document.getElementById('upload-files-close-footer');
        closeFooterBtn?.addEventListener('click', () => this.closeModal());

        // Event delegation on the persistent file list container: rows carry
        // data-action / data-* attributes instead of inline onclick handlers,
        // so untrusted filenames never land in executable strings (XSS).
        const fileListDiv = document.getElementById('file-list');
        fileListDiv?.addEventListener('click', (e) => {
            const target = (e.target as HTMLElement)?.closest('[data-action]') as HTMLElement | null;
            if (!target) return;
            const action = target.dataset.action;
            const fileType = target.dataset.fileType || '';
            if (action === 'navigate-path') {
                void this.navigateToPath(fileType, target.dataset.path || '');
            } else if (action === 'navigate-folder') {
                void this.navigateToFolder(fileType, target.dataset.name || '');
            } else if (action === 'run-scenario') {
                this.runScenario(target.dataset.name || '');
            } else if (action === 'delete') {
                void this.deleteFile(fileType, target.dataset.name || '');
            }
        });

        logger.debug('BlueSkyFileManager', 'Event handlers initialized');
    }

    private async checkCurrentStatus(): Promise<void> {
        try {
            const response = await fetch('/api/bluesky/filestatus');
            const status: BlueSkyFileStatus = await response.json();

            if (status.configured && status.base_path) {
                this.isConfigured = true;
                this.updateUIForConfiguredState(status);
            } else {
                this.updateUIForUnconfiguredState();
            }
        } catch (error) {
            logger.error('BlueSkyFileManager', 'Failed to check status:', error);
            this.updateUIForUnconfiguredState();
        }
    }

    private updateUIForConfiguredState(status: BlueSkyFileStatus): void {
        // Update base path input in settings modal
        const basePathInput = document.getElementById('bluesky-base-path-input-settings') as HTMLInputElement;
        if (basePathInput && status.base_path) {
            basePathInput.value = status.base_path;
            // Save the path to localStorage if it's different from what's saved
            const savedPath = storage.getStringWithLegacyMigration(
                BlueSkyFileManager.BASE_PATH_KEY,
                BlueSkyFileManager.BASE_PATH_KEY
            );
            if (savedPath !== status.base_path) {
                this.saveBasePath(status.base_path);
            }
        }

        // Show status in settings modal
        const statusDiv = document.getElementById('base-path-status-settings');
        if (statusDiv && status.derived_paths) {
            this.renderDerivedPaths(status.derived_paths, '-settings');
            statusDiv.style.display = 'block';
        }

        // Show upload and management sections in upload modal
        const uploadSection = document.getElementById('file-upload-section');
        const managementSection = document.getElementById('file-management-section');
        if (uploadSection) uploadSection.style.display = 'block';
        if (managementSection) managementSection.style.display = 'block';
        
        // Hide "not configured" notice and show configured status in upload modal
        const notConfiguredDiv = document.getElementById('base-path-not-configured');
        const configuredStatusDiv = document.getElementById('base-path-status');
        if (notConfiguredDiv) notConfiguredDiv.style.display = 'none';
        if (configuredStatusDiv && status.derived_paths) {
            this.renderDerivedPaths(status.derived_paths, '');
            configuredStatusDiv.style.display = 'block';
        }

        this.refreshFileList();
    }

    /** Fill the derived-path displays; the settings modal's ids carry a
     *  '-settings' suffix, the upload modal's none. */
    private renderDerivedPaths(
        paths: NonNullable<BlueSkyFileStatus['derived_paths']>,
        idSuffix: '' | '-settings'
    ): void {
        for (const type of ['scenario', 'plugins', 'settings', 'output'] as const) {
            setText(`${type}-path-display${idSuffix}`, paths[type]);
        }
    }

    private updateUIForUnconfiguredState(): void {
        // Hide status in settings modal
        const statusDiv = document.getElementById('base-path-status-settings');
        if (statusDiv) {
            statusDiv.style.display = 'none';
        }
        
        // Hide upload and management sections in upload modal
        const uploadSection = document.getElementById('file-upload-section');
        const managementSection = document.getElementById('file-management-section');
        if (uploadSection) uploadSection.style.display = 'none';
        if (managementSection) managementSection.style.display = 'none';
        
        // Show "not configured" notice and hide configured status in upload modal
        const notConfiguredDiv = document.getElementById('base-path-not-configured');
        const configuredStatusDiv = document.getElementById('base-path-status');
        if (notConfiguredDiv) notConfiguredDiv.style.display = 'block';
        if (configuredStatusDiv) configuredStatusDiv.style.display = 'none';
    }

    private async configureBasePath(): Promise<void> {
        const basePathInput = document.getElementById('bluesky-base-path-input-settings') as HTMLInputElement;
        const basePath = basePathInput.value.trim();

        if (!basePath) {
            this.showStatus('Please enter a base path', 'error');
            return;
        }

        const configureBtn = document.getElementById('configure-base-path-btn-settings') as HTMLButtonElement;
        configureBtn.disabled = true;
        configureBtn.textContent = 'Configuring...';

        try {
            const response = await fetch('/api/bluesky/configure-base-path', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ base_path: basePath })
            });

            const result = await response.json();

            if (result.success) {
                this.isConfigured = true;
                this.showStatus('Base path configured successfully!', 'success');
                
                // Save the successful path to localStorage
                this.saveBasePath(result.base_path);
                
                // Update UI in both settings modal and upload modal
                this.updateUIForConfiguredState({
                    configured: true,
                    base_path: result.base_path,
                    derived_paths: result.derived_paths
                });
            } else {
                this.showStatus(`Configuration failed: ${result.error}`, 'error');
            }
        } catch (error) {
            logger.error('BlueSkyFileManager', 'Configuration error:', error);
            this.showStatus('Configuration failed. Please check the path.', 'error');
        } finally {
            configureBtn.disabled = false;
            configureBtn.textContent = 'Configure';
        }
    }

    /**
     * Switch file management into integrated mode (integrated build only).
     *
     * There the backend wires BlueSky's directories up automatically (see
     * webatm_integrated.bluesky_paths), so the manual "BlueSky Base Directory"
     * controls are hidden; the auto-configured paths still show via the normal
     * configured-state UI. Never called in the default build.
     */
    public enableIntegratedMode(): void {
        if (this.integratedMode) return;
        this.integratedMode = true;
        onDOMReady(() => this.applyIntegratedMode());
    }

    /**
     * Hide the manual base-path configuration controls. Safe to call repeatedly.
     */
    private applyIntegratedMode(): void {
        // The whole manual-configuration affordance lives in one .setting-group;
        // hiding it leaves the configured-paths status (a sibling) intact.
        const input = document.getElementById('bluesky-base-path-input-settings');
        const configGroup = input?.closest('.setting-group');
        if (configGroup instanceof HTMLElement) {
            setVisible(configGroup, false);
        }

        // The section now just reports the fixed paths.
        const description = input
            ?.closest('.settings-section')
            ?.querySelector('.section-description');
        if (description) {
            description.textContent =
                "BlueSky's scenario, plugins, and output directories — configured automatically in WebATM Integrated.";
        }
    }

    private updateFileInputAccept(): void {
        const fileTypeSelect = document.getElementById('file-type-select') as HTMLSelectElement;
        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        const uploadAndRunBtn = document.getElementById('upload-and-run-scenario-btn') as HTMLButtonElement;
        
        const selectedType = fileTypeSelect.value;
        const extension = this.fileExtensions[selectedType];

        if (extension && fileInput) {
            fileInput.accept = extension;
        }

        // Show/hide upload and run scenario button based on file type
        if (uploadAndRunBtn) {
            if (selectedType === 'scenario') {
                uploadAndRunBtn.style.display = 'block';
            } else {
                uploadAndRunBtn.style.display = 'none';
            }
        }
    }

    private handleFileSelection(): void {
        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        const uploadBtn = document.getElementById('upload-file-btn') as HTMLButtonElement;
        const uploadAndRunBtn = document.getElementById('upload-and-run-scenario-btn') as HTMLButtonElement;
        
        if (fileInput.files && fileInput.files.length > 0) {
            uploadBtn.disabled = false;
            if (uploadAndRunBtn) {
                uploadAndRunBtn.disabled = false;
            }
            this.showStatus(`Selected: ${fileInput.files[0].name}`, 'info');
        } else {
            uploadBtn.disabled = true;
            if (uploadAndRunBtn) {
                uploadAndRunBtn.disabled = true;
            }
        }
    }

    private handleDragOver(e: DragEvent): void {
        e.preventDefault();
        (e.currentTarget as HTMLElement).classList.add('drag-over');
    }

    private clearDropHighlight(): void {
        document.getElementById('file-drop-zone')?.classList.remove('drag-over');
    }

    private handleDrop(e: DragEvent): void {
        e.preventDefault();
        (e.currentTarget as HTMLElement).classList.remove('drag-over');

        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            const fileInput = document.getElementById('file-input') as HTMLInputElement;
            fileInput.files = files;
            this.handleFileSelection();
        }
    }

    private async uploadAndRunScenario(): Promise<void> {
        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        const fileTypeSelect = document.getElementById('file-type-select') as HTMLSelectElement;
        
        if (!fileInput.files || fileInput.files.length === 0) {
            this.showStatus('Please select a scenario file first', 'error');
            return;
        }

        const file = fileInput.files[0];
        const fileType = fileTypeSelect.value;

        if (fileType !== 'scenario') {
            this.showStatus('This function is only available for scenario files', 'error');
            return;
        }

        const uploadAndRunBtn = document.getElementById('upload-and-run-scenario-btn') as HTMLButtonElement;
        uploadAndRunBtn.disabled = true;
        uploadAndRunBtn.textContent = 'Uploading...';

        try {
            const storedFilename = await this.performFileUpload(file, fileType);

            if (storedFilename) {
                this.showStatus('File uploaded successfully! Running scenario...', 'success');
                this.closeModal();

                // IC runs the full stored name, .scn included — see
                // runScenario() for why the extension must be kept.
                if (window.app) {
                    window.app.sendCommand(`IC ${storedFilename}`);
                } else {
                    this.showStatus('Could not run scenario: Application not available', 'error');
                }
            }
        } catch (error) {
            logger.error('BlueSkyFileManager', 'Upload and run error:', error);
            this.showStatus('Upload and run failed. Please try again.', 'error');
        } finally {
            uploadAndRunBtn.disabled = false;
            uploadAndRunBtn.textContent = 'Upload File and run scenario';
        }
    }

    /**
     * Upload a file and return the filename the backend stored it under
     * (which can differ from `file.name`), or null on failure.
     */
    private async performFileUpload(file: File, fileType: string): Promise<string | null> {
        const extension = this.fileExtensions[fileType];
        if (!file.name.toLowerCase().endsWith(extension)) {
            this.showStatus(`Invalid file type. Expected ${extension} file.`, 'error');
            return null;
        }

        // Size limits mirror the backend's (50MB scenarios, 10MB others).
        const maxSize = fileType === 'scenario' ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
        if (file.size > maxSize) {
            const maxSizeMB = Math.floor(maxSize / (1024 * 1024));
            this.showStatus(`File too large. Maximum size: ${maxSizeMB}MB`, 'error');
            return null;
        }

        const progressDiv = document.getElementById('upload-progress');
        const progressBar = document.getElementById('upload-progress-bar');
        // A hide timeout still pending from the previous upload would blank
        // this upload's progress bar mid-flight — cancel it first.
        if (this.progressHideTimer !== null) {
            clearTimeout(this.progressHideTimer);
            this.progressHideTimer = null;
        }
        progressDiv!.style.display = 'block';

        try {
            const formData = new FormData();
            formData.append('file', file);

            // Simulate progress (fetch exposes no real upload progress).
            let progress = 0;
            const progressInterval = setInterval(() => {
                progress += 10;
                if (progress <= 90) {
                    progressBar!.style.width = `${progress}%`;
                    progressBar!.textContent = `${progress}%`;
                }
            }, 100);

            const response = await fetch(`/api/bluesky/upload/${fileType}`, {
                method: 'POST',
                body: formData
            });

            clearInterval(progressInterval);
            progressBar!.style.width = '100%';
            progressBar!.textContent = '100%';

            const result: UploadResponse = await response.json();

            if (result.success) {
                return result.filename ?? file.name;
            }
            this.showStatus(`Upload failed: ${result.error}`, 'error');
            return null;
        } catch (error) {
            logger.error('BlueSkyFileManager', 'Upload error:', error);
            this.showStatus('Upload failed. Please try again.', 'error');
            return null;
        } finally {
            // Hide the progress bar after a delay.
            this.progressHideTimer = setTimeout(() => {
                this.progressHideTimer = null;
                progressDiv!.style.display = 'none';
                progressBar!.style.width = '0%';
                progressBar!.textContent = '0%';
            }, 2000);
        }
    }

    private async uploadFile(): Promise<void> {
        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        const fileTypeSelect = document.getElementById('file-type-select') as HTMLSelectElement;
        
        if (!fileInput.files || fileInput.files.length === 0) {
            this.showStatus('Please select a file first', 'error');
            return;
        }

        const file = fileInput.files[0];
        const fileType = fileTypeSelect.value;

        const uploadBtn = document.getElementById('upload-file-btn') as HTMLButtonElement;
        uploadBtn.disabled = true;
        uploadBtn.textContent = 'Uploading...';

        try {
            // Report the stored name (the backend auto-renames on conflict).
            const storedFilename = await this.performFileUpload(file, fileType);

            if (storedFilename) {
                this.showStatus(`File uploaded successfully: ${storedFilename}`, 'success');

                fileInput.value = '';
                this.handleFileSelection();
                this.refreshFileList();
            }
        } catch (error) {
            logger.error('BlueSkyFileManager', 'Upload error:', error);
            this.showStatus('Upload failed. Please try again.', 'error');
        } finally {
            uploadBtn.disabled = false;
            uploadBtn.textContent = 'Upload File';
        }
    }

    private async refreshFileList(): Promise<void> {
        if (!this.isConfigured) return;

        const viewFileTypeSelect = document.getElementById('view-file-type-select') as HTMLSelectElement;
        const fileType = viewFileTypeSelect.value;
        const fileListDiv = document.getElementById('file-list');

        if (!fileListDiv) return;

        try {
            const currentPath = this.currentPaths[fileType] || '';
            const url = currentPath ?
                `/api/bluesky/browse/${fileType}/${this.encodePath(currentPath)}` :
                `/api/bluesky/browse/${fileType}`;

            const response = await fetch(url);
            const result: BrowseDirectoryResponse = await response.json();

            if (result.success) {
                this.renderFileList(result.files, fileType, result.breadcrumbs);
            } else {
                fileListDiv.innerHTML = `<div style="padding: 16px; text-align: center; color: #f44336;">Error loading files</div>`;
            }
        } catch (error) {
            logger.error('BlueSkyFileManager', 'Failed to load file list:', error);
            fileListDiv.innerHTML = `<div style="padding: 16px; text-align: center; color: #f44336;">Failed to load files</div>`;
        }
    }

    private renderFileList(files: UploadedFile[], fileType: string, breadcrumbs?: Breadcrumb[]): void {
        const fileListDiv = document.getElementById('file-list');
        if (!fileListDiv) return;

        let content = '';

        // Add breadcrumb navigation if we have breadcrumbs
        if (breadcrumbs && breadcrumbs.length > 1) {
            const breadcrumbItems = breadcrumbs.map((crumb, index) => {
                const isLast = index === breadcrumbs.length - 1;
                const attrs = isLast ? '' : `data-action="navigate-path" data-file-type="${escapeHtml(fileType)}" data-path="${escapeHtml(crumb.path)}"`;
                const style = isLast ? 'color: #fff; font-weight: bold;' : 'color: #4CAF50; cursor: pointer;';

                return `<span style="${style}" ${attrs}>${escapeHtml(crumb.name)}</span>`;
            }).join(' <span style="color: #666;">/</span> ');

            content += `
                <div style="padding: 8px; background-color: #2a2a2a; border-bottom: 1px solid #444; font-size: 12px;">
                    <i class="fa fa-home" style="margin-right: 5px;"></i>${breadcrumbItems}
                </div>
            `;
        }

        if (files.length === 0) {
            content += `<div style="padding: 16px; text-align: center; color: #666;">No ${fileType} files uploaded</div>`;
            fileListDiv.innerHTML = content;
            return;
        }

        const fileItems = files.map(file => {
            const modifiedDate = new Date(file.modified * 1000).toLocaleDateString();
            const isFolder = file.type === 'folder';
            const icon = isFolder ? '📁' : '';
            const sizeText = isFolder ? 'Folder' : `${Math.round(file.size / 1024)} KB`;
            const folderAttrs = isFolder ? `data-action="navigate-folder" data-file-type="${escapeHtml(fileType)}" data-name="${escapeHtml(file.filename)}"` : '';
            const cursorStyle = isFolder ? 'cursor: pointer;' : '';
            const safeName = escapeHtml(file.filename);

            return `
                <div style="padding: 8px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center;">
                    <div style="${cursorStyle}" ${folderAttrs}>
                        <div style="font-weight: bold; ${isFolder ? 'color: #4CAF50;' : ''}">${icon} ${safeName}</div>
                        <div style="font-size: 11px; color: #888;">${escapeHtml(sizeText)} • ${modifiedDate}</div>
                    </div>
                    ${isFolder ? '' : `
                    <div style="display: flex; gap: 4px;">
                        ${fileType === 'scenario' ? `
                        <button class="btn-primary" data-action="run-scenario" data-name="${safeName}" style="padding: 4px 8px; font-size: 11px;">
                            ▶️ Run
                        </button>
                        ` : ''}
                        <button class="btn-secondary" data-action="delete" data-file-type="${escapeHtml(fileType)}" data-name="${safeName}" style="padding: 4px 8px; font-size: 11px;">
                            🗑️ Delete
                        </button>
                    </div>
                    `}
                </div>
            `;
        }).join('');

        content += fileItems;
        fileListDiv.innerHTML = content;
    }

    public async navigateToFolder(fileType: string, folderName: string): Promise<void> {
        const currentPath = this.currentPaths[fileType] || '';
        const newPath = currentPath ? `${currentPath}/${folderName}` : folderName;
        
        this.currentPaths[fileType] = newPath;
        await this.refreshFileList();
    }

    public async navigateToPath(fileType: string, path: string): Promise<void> {
        this.currentPaths[fileType] = path;
        await this.refreshFileList();
    }

    /** Path of a listed file relative to its file type's base directory,
     *  including the currently browsed subfolder. */
    private relativePath(fileType: string, filename: string): string {
        const currentPath = this.currentPaths[fileType] || '';
        return currentPath ? `${currentPath}/${filename}` : filename;
    }

    /** Percent-encode each segment of a relative path for use in a URL,
     *  keeping the '/' separators so the backend sees the same hierarchy. */
    private encodePath(path: string): string {
        return path.split('/').map(encodeURIComponent).join('/');
    }

    public runScenario(filename: string): void {
        // Keep the .scn extension: BlueSky's IC forces one onto the name via
        // Path.with_suffix, which would rewrite a stripped dotted name
        // ("demo.v2" -> "demo.scn") and silently run the wrong scenario.
        const scenarioName = this.relativePath('scenario', filename);

        this.closeModal();

        if (window.app) {
            const command = `IC ${scenarioName}`;
            window.app.sendCommand(command);
            logger.debug('BlueSkyFileManager', `Running scenario: ${command}`);
        } else {
            this.showStatus('Could not run scenario: Application not available', 'error');
        }
    }

    public async deleteFile(fileType: string, filename: string): Promise<void> {
        if (!confirm(`Are you sure you want to delete ${filename}?`)) {
            return;
        }

        try {
            // Delete the file in the folder being browsed, not a root namesake.
            const relPath = this.encodePath(this.relativePath(fileType, filename));
            const response = await fetch(`/api/bluesky/${fileType}/${relPath}`, {
                method: 'DELETE'
            });

            const result = await response.json();

            if (result.success) {
                this.showStatus(`File deleted: ${filename}`, 'success');
                this.refreshFileList();
            } else {
                this.showStatus(`Delete failed: ${result.error}`, 'error');
            }
        } catch (error) {
            logger.error('BlueSkyFileManager', 'Delete error:', error);
            this.showStatus('Delete failed. Please try again.', 'error');
        }
    }

    private showStatus(message: string, type: 'success' | 'error' | 'info'): void {
        const statusDiv = document.getElementById('upload-status');
        if (!statusDiv) return;

        const colors = {
            success: '#4CAF50',
            error: '#f44336',
            info: '#2196F3'
        };

        // An auto-clear timeout from an earlier toast must not wipe this one
        // (it would hide a persistent error 5s after the previous info/success
        // message, e.g. "Selected: …" followed by an upload error).
        if (this.statusClearTimer !== null) {
            clearTimeout(this.statusClearTimer);
            this.statusClearTimer = null;
        }

        // Escape: messages embed untrusted names (picked/stored filenames,
        // backend error text) and this is an innerHTML sink.
        statusDiv.innerHTML = `
            <div style="padding: 8px; border-radius: 4px; background-color: ${colors[type]}20; border: 1px solid ${colors[type]}; color: ${colors[type]};">
                ${escapeHtml(message)}
            </div>
        `;

        // Clear status after a delay (except for errors, which persist)
        if (type !== 'error') {
            this.statusClearTimer = setTimeout(() => {
                this.statusClearTimer = null;
                statusDiv.innerHTML = '';
            }, 5000);
        }
    }

    public closeModal(): void {
        modalManager.close('upload-files-modal');
    }

    // Open through modalManager (not by setting style.display directly) so the
    // modal participates in Escape/backdrop close and one-modal-at-a-time.
    public openModal(): void {
        if (!modalManager.open('upload-files-modal')) return;

        // Reset browse state and refresh status on every open
        this.currentPaths = {
            scenario: '',
            plugins: '',
            settings: ''
        };
        this.checkCurrentStatus();
    }

    /**
     * Save the BlueSky base path to localStorage
     */
    private saveBasePath(basePath: string): void {
        if (storage.set(BlueSkyFileManager.BASE_PATH_KEY, basePath)) {
            logger.debug('BlueSkyFileManager', `Saved base path to localStorage: ${basePath}`);
        }
    }

    /**
     * Load the BlueSky base path from localStorage
     */
    private loadSavedBasePath(): void {
        const savedPath = storage.getStringWithLegacyMigration(
            BlueSkyFileManager.BASE_PATH_KEY,
            BlueSkyFileManager.BASE_PATH_KEY
        );
        if (savedPath) {
            const basePathInput = document.getElementById('bluesky-base-path-input-settings') as HTMLInputElement;
            if (basePathInput) {
                basePathInput.value = savedPath;
                logger.debug('BlueSkyFileManager', `Loaded saved base path: ${savedPath}`);
            }
        }
    }

}

// Export singleton instance
export const blueSkyFileManager = new BlueSkyFileManager();

// Exposed on window for global access (typed in types/globals.d.ts).
window.blueSkyFileManager = blueSkyFileManager;