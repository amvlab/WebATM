import { logger } from '../utils/Logger';
import { storage } from '../utils/StorageManager';
import { onDOMReady, setVisible, escapeHtml } from '../utils/dom';

interface FileTypeConfig {
    extension: string;
    directory?: string;
    filepath?: string;
    allowMultiple: boolean;
}

interface BlueSkyFileStatus {
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

/**
 * BlueSky File Manager
 * Handles file uploads for scenarios, plugins, and settings files
 */
export class BlueSkyFileManager {
    private static readonly BASE_PATH_KEY = 'bluesky-base-path';

    private fileTypeConfigs: Record<string, FileTypeConfig> = {
        scenario: { extension: '.scn', directory: 'scenario', allowMultiple: true },
        plugins: { extension: '.py', directory: 'plugins', allowMultiple: true },
        settings: { extension: '.cfg', filepath: 'settings.cfg', allowMultiple: false }
    };

    private isConfigured: boolean = false;
    // Integrated build only: when true the manual "BlueSky Base Directory"
    // controls are hidden because the backend wires file management straight to
    // BlueSky's working directory. Activated via enableIntegratedMode(); stays
    // false (and a no-op) in the default build.
    private integratedMode: boolean = false;
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
        // Initialize button visibility based on default file type
        this.updateFileInputAccept();
    }

    private setupEventHandlers(): void {
        // Configure base path button (now in settings modal)
        const configureBtn = document.getElementById('configure-base-path-btn-settings');
        configureBtn?.addEventListener('click', () => this.configureBasePath());

        // File type selector
        const fileTypeSelect = document.getElementById('file-type-select') as HTMLSelectElement;
        fileTypeSelect?.addEventListener('change', () => this.updateFileInputAccept());

        // File input and drop zone
        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        const dropZone = document.getElementById('file-drop-zone');

        fileInput?.addEventListener('change', () => this.handleFileSelection());
        dropZone?.addEventListener('click', () => fileInput?.click());
        
        // Drag and drop
        dropZone?.addEventListener('dragover', (e) => this.handleDragOver(e));
        dropZone?.addEventListener('drop', (e) => this.handleDrop(e));

        // Upload button
        const uploadBtn = document.getElementById('upload-file-btn');
        uploadBtn?.addEventListener('click', () => this.uploadFile());

        // Upload and run scenario button
        const uploadAndRunBtn = document.getElementById('upload-and-run-scenario-btn');
        uploadAndRunBtn?.addEventListener('click', () => this.uploadAndRunScenario());

        // File management
        const refreshBtn = document.getElementById('refresh-files-btn');
        const viewFileTypeSelect = document.getElementById('view-file-type-select') as HTMLSelectElement;
        
        refreshBtn?.addEventListener('click', () => this.refreshFileList());
        viewFileTypeSelect?.addEventListener('change', () => {
            // Reset current path when changing file types
            const fileType = viewFileTypeSelect.value;
            this.currentPaths[fileType] = '';
            this.refreshFileList();
        });

        // Close button handlers
        const closeFooterBtn = document.getElementById('upload-files-close-footer');
        closeFooterBtn?.addEventListener('click', () => this.closeModal());

        // Event delegation on the (persistent) file list container. Rows and
        // buttons carry data-action / data-* attributes instead of inline
        // onclick handlers, so untrusted filenames are never interpolated into
        // executable strings (XSS risk).
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
            document.getElementById('scenario-path-display-settings')!.textContent = status.derived_paths.scenario;
            document.getElementById('plugins-path-display-settings')!.textContent = status.derived_paths.plugins;
            document.getElementById('settings-path-display-settings')!.textContent = status.derived_paths.settings;
            document.getElementById('output-path-display-settings')!.textContent = status.derived_paths.output;
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
            const scenarioDisplay = document.getElementById('scenario-path-display');
            const pluginsDisplay = document.getElementById('plugins-path-display');
            const settingsDisplay = document.getElementById('settings-path-display');
            const outputDisplay = document.getElementById('output-path-display');

            if (scenarioDisplay) scenarioDisplay.textContent = status.derived_paths.scenario;
            if (pluginsDisplay) pluginsDisplay.textContent = status.derived_paths.plugins;
            if (settingsDisplay) settingsDisplay.textContent = status.derived_paths.settings;
            if (outputDisplay) outputDisplay.textContent = status.derived_paths.output;
            configuredStatusDiv.style.display = 'block';
        }

        this.refreshFileList();
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
     * In the integrated build BlueSky runs inside the same container as the
     * WebATM backend, so its scenario/plugins/output directories live at a
     * fixed path that the backend wires up automatically (see
     * webatm_integrated.bluesky_paths). There is nothing for the user to
     * configure, so hide the "BlueSky Base Directory" input + Configure button;
     * the auto-configured paths are still shown via the normal configured-state
     * UI. Never called in the default build, so it stays a no-op there.
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
        // The input, Configure button, help text and "file system access"
        // warning all live in one .setting-group; hiding it removes the whole
        // manual-configuration affordance while leaving the configured-paths
        // status display (a sibling element) intact.
        const input = document.getElementById('bluesky-base-path-input-settings');
        const configGroup = input?.closest('.setting-group');
        if (configGroup instanceof HTMLElement) {
            setVisible(configGroup, false);
        }

        // The section now just reports the fixed paths, so drop the "Configure
        // …" wording that no longer applies.
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
        const config = this.fileTypeConfigs[selectedType];
        
        if (config && fileInput) {
            fileInput.accept = config.extension;
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
        const dropZone = e.currentTarget as HTMLElement;
        dropZone.style.borderColor = '#4CAF50';
        dropZone.style.backgroundColor = '#1a2a1a';
    }

    private handleDrop(e: DragEvent): void {
        e.preventDefault();
        const dropZone = e.currentTarget as HTMLElement;
        dropZone.style.borderColor = '#555';
        dropZone.style.backgroundColor = '#222';

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
        
        // Ensure we're dealing with a scenario file
        if (fileType !== 'scenario') {
            this.showStatus('This function is only available for scenario files', 'error');
            return;
        }

        // Validate file extension
        const config = this.fileTypeConfigs[fileType];
        if (!file.name.toLowerCase().endsWith(config.extension)) {
            this.showStatus(`Invalid file type. Expected ${config.extension} file.`, 'error');
            return;
        }

        // Extract scenario name (remove .scn extension)
        const scenarioName = file.name.replace(/\.scn$/i, '');

        const uploadAndRunBtn = document.getElementById('upload-and-run-scenario-btn') as HTMLButtonElement;
        uploadAndRunBtn.disabled = true;
        uploadAndRunBtn.textContent = 'Uploading...';

        try {
            // Upload the file first
            const uploadSuccess = await this.performFileUpload(file, fileType);
            
            if (uploadSuccess) {
                this.showStatus('File uploaded successfully! Running scenario...', 'success');
                
                // Close the modal
                this.closeModal();
                
                // Send IC command to run the scenario
                if (window.app) {
                    const command = `IC ${scenarioName}`;
                    window.app.sendCommand(command);
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

    private async performFileUpload(file: File, fileType: string): Promise<boolean> {
        // Validate file extension
        const config = this.fileTypeConfigs[fileType];
        if (!file.name.toLowerCase().endsWith(config.extension)) {
            this.showStatus(`Invalid file type. Expected ${config.extension} file.`, 'error');
            return false;
        }

        // Validate file size (max 50MB for scenario files, 10MB for others)
        const maxSize = fileType === 'scenario' ? 50 * 1024 * 1024 : 10 * 1024 * 1024; // 50MB or 10MB
        if (file.size > maxSize) {
            const maxSizeMB = Math.floor(maxSize / (1024 * 1024));
            this.showStatus(`File too large. Maximum size: ${maxSizeMB}MB`, 'error');
            return false;
        }

        // Show progress bar
        const progressDiv = document.getElementById('upload-progress');
        const progressBar = document.getElementById('upload-progress-bar');
        progressDiv!.style.display = 'block';

        try {
            const formData = new FormData();
            formData.append('file', file);

            // Simulate progress (since we can't get real progress from fetch easily)
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

            const result = await response.json();

            if (result.success) {
                // Hide progress bar after a delay
                setTimeout(() => {
                    progressDiv!.style.display = 'none';
                    progressBar!.style.width = '0%';
                    progressBar!.textContent = '0%';
                }, 2000);
                
                return true;
            } else {
                this.showStatus(`Upload failed: ${result.error}`, 'error');
                return false;
            }
        } catch (error) {
            logger.error('BlueSkyFileManager', 'Upload error:', error);
            this.showStatus('Upload failed. Please try again.', 'error');
            return false;
        } finally {
            // Hide progress bar after a delay if not already hidden
            setTimeout(() => {
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
            const uploadSuccess = await this.performFileUpload(file, fileType);
            
            if (uploadSuccess) {
                this.showStatus(`File uploaded successfully: ${file.name}`, 'success');
                
                // Clear file input
                fileInput.value = '';
                this.handleFileSelection();
                
                // Refresh file list
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
            // Use the new browse API with current path
            const currentPath = this.currentPaths[fileType] || '';
            const url = currentPath ? 
                `/api/bluesky/browse/${fileType}/${encodeURIComponent(currentPath)}` : 
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

    public runScenario(filename: string): void {
        // Build the relative path from the scenario directory
        const currentPath = this.currentPaths['scenario'] || '';
        let scenarioPath = filename;
        
        if (currentPath) {
            scenarioPath = `${currentPath}/${filename}`;
        }
        
        // Remove .scn extension for the IC command
        const scenarioName = scenarioPath.replace(/\.scn$/i, '');
        
        // Close the modal
        this.closeModal();
        
        // Send IC command to run the scenario
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
            const response = await fetch(`/api/bluesky/${fileType}/${filename}`, {
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

        statusDiv.innerHTML = `
            <div style="padding: 8px; border-radius: 4px; background-color: ${colors[type]}20; border: 1px solid ${colors[type]}; color: ${colors[type]};">
                ${message}
            </div>
        `;

        // Clear status after a delay (except for errors)
        if (type !== 'error') {
            setTimeout(() => {
                statusDiv.innerHTML = '';
            }, 5000);
        }
    }

    public closeModal(): void {
        const modal = document.getElementById('upload-files-modal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    public openModal(): void {
        const modal = document.getElementById('upload-files-modal');
        if (modal) {
            modal.style.display = 'block';
            // Reset all current paths when opening the modal
            this.currentPaths = {
                scenario: '',
                plugins: '',
                settings: ''
            };
            this.checkCurrentStatus(); // Refresh status when opening
        }
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