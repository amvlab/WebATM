import { logger } from '../utils/Logger';

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

interface ListFilesResponse {
    success: boolean;
    file_type: string;
    files: UploadedFile[];
    base_path: string;
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
    private fileTypeConfigs: Record<string, FileTypeConfig> = {
        scenario: { extension: '.scn', directory: 'scenario', allowMultiple: true },
        plugins: { extension: '.py', directory: 'plugins', allowMultiple: true },
        settings: { extension: '.cfg', filepath: 'settings.cfg', allowMultiple: false }
    };

    private isConfigured: boolean = false;
    private currentPaths: Record<string, string> = {
        scenario: '',
        plugins: '',
        settings: ''
    };

    constructor() {
        this.init();
    }

    private init(): void {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.initializeFileManager());
        } else {
            this.initializeFileManager();
        }
    }

    private initializeFileManager(): void {
        this.setupEventHandlers();
        this.loadSavedBasePath();
        this.checkCurrentStatus();
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
            const savedPath = localStorage.getItem('bluesky-base-path');
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
            
            if (scenarioDisplay) scenarioDisplay.textContent = status.derived_paths.scenario;
            if (pluginsDisplay) pluginsDisplay.textContent = status.derived_paths.plugins;
            if (settingsDisplay) settingsDisplay.textContent = status.derived_paths.settings;
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

    private updateFileInputAccept(): void {
        const fileTypeSelect = document.getElementById('file-type-select') as HTMLSelectElement;
        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        
        const selectedType = fileTypeSelect.value;
        const config = this.fileTypeConfigs[selectedType];
        
        if (config && fileInput) {
            fileInput.accept = config.extension;
        }
    }

    private handleFileSelection(): void {
        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        const uploadBtn = document.getElementById('upload-file-btn') as HTMLButtonElement;
        
        if (fileInput.files && fileInput.files.length > 0) {
            uploadBtn.disabled = false;
            this.showStatus(`Selected: ${fileInput.files[0].name}`, 'info');
        } else {
            uploadBtn.disabled = true;
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

    private async uploadFile(): Promise<void> {
        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        const fileTypeSelect = document.getElementById('file-type-select') as HTMLSelectElement;
        
        if (!fileInput.files || fileInput.files.length === 0) {
            this.showStatus('Please select a file first', 'error');
            return;
        }

        const file = fileInput.files[0];
        const fileType = fileTypeSelect.value;
        
        // Validate file extension
        const config = this.fileTypeConfigs[fileType];
        if (!file.name.toLowerCase().endsWith(config.extension)) {
            this.showStatus(`Invalid file type. Expected ${config.extension} file.`, 'error');
            return;
        }

        // Validate file size (max 50MB for scenario files, 10MB for others)
        const maxSize = fileType === 'scenario' ? 50 * 1024 * 1024 : 10 * 1024 * 1024; // 50MB or 10MB
        if (file.size > maxSize) {
            const maxSizeMB = Math.floor(maxSize / (1024 * 1024));
            this.showStatus(`File too large. Maximum size: ${maxSizeMB}MB`, 'error');
            return;
        }

        const uploadBtn = document.getElementById('upload-file-btn') as HTMLButtonElement;
        uploadBtn.disabled = true;
        uploadBtn.textContent = 'Uploading...';

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
                this.showStatus(`File uploaded successfully: ${result.filename}`, 'success');
                
                // Clear file input
                fileInput.value = '';
                this.handleFileSelection();
                
                // Refresh file list
                this.refreshFileList();
            } else {
                this.showStatus(`Upload failed: ${result.error}`, 'error');
            }
        } catch (error) {
            logger.error('BlueSkyFileManager', 'Upload error:', error);
            this.showStatus('Upload failed. Please try again.', 'error');
        } finally {
            uploadBtn.disabled = false;
            uploadBtn.textContent = 'Upload File';
            
            // Hide progress bar after a delay
            setTimeout(() => {
                progressDiv!.style.display = 'none';
                progressBar!.style.width = '0%';
                progressBar!.textContent = '0%';
            }, 2000);
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
                const clickHandler = isLast ? '' : `onclick="blueSkyFileManager.navigateToPath('${fileType}', '${crumb.path}')"`;
                const style = isLast ? 'color: #fff; font-weight: bold;' : 'color: #4CAF50; cursor: pointer;';
                
                return `<span style="${style}" ${clickHandler}>${crumb.name}</span>`;
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
            const clickHandler = isFolder ? `onclick="blueSkyFileManager.navigateToFolder('${fileType}', '${file.filename}')"` : '';
            const cursorStyle = isFolder ? 'cursor: pointer;' : '';
            
            return `
                <div style="padding: 8px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center;">
                    <div style="${cursorStyle}" ${clickHandler}>
                        <div style="font-weight: bold; ${isFolder ? 'color: #4CAF50;' : ''}">${icon} ${file.filename}</div>
                        <div style="font-size: 11px; color: #888;">${sizeText} • ${modifiedDate}</div>
                    </div>
                    ${isFolder ? '' : `
                    <button class="btn-secondary" onclick="blueSkyFileManager.deleteFile('${fileType}', '${file.filename}')" style="padding: 4px 8px; font-size: 11px;">
                        🗑️ Delete
                    </button>
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
        try {
            localStorage.setItem('bluesky-base-path', basePath);
            logger.debug('BlueSkyFileManager', `Saved base path to localStorage: ${basePath}`);
        } catch (error) {
            logger.warn('BlueSkyFileManager', 'Failed to save base path to localStorage:', error);
        }
    }

    /**
     * Load the BlueSky base path from localStorage
     */
    private loadSavedBasePath(): void {
        try {
            const savedPath = localStorage.getItem('bluesky-base-path');
            if (savedPath) {
                const basePathInput = document.getElementById('bluesky-base-path-input-settings') as HTMLInputElement;
                if (basePathInput) {
                    basePathInput.value = savedPath;
                    logger.debug('BlueSkyFileManager', `Loaded saved base path: ${savedPath}`);
                }
            }
        } catch (error) {
            logger.warn('BlueSkyFileManager', 'Failed to load base path from localStorage:', error);
        }
    }

    /**
     * Clear the saved BlueSky base path from localStorage
     */
    private clearSavedBasePath(): void {
        try {
            localStorage.removeItem('bluesky-base-path');
            logger.debug('BlueSkyFileManager', 'Cleared saved base path from localStorage');
        } catch (error) {
            logger.warn('BlueSkyFileManager', 'Failed to clear base path from localStorage:', error);
        }
    }
}

// Export singleton instance
export const blueSkyFileManager = new BlueSkyFileManager();

// Make it globally available for onclick handlers
declare global {
    interface Window {
        blueSkyFileManager: BlueSkyFileManager;
    }
}
window.blueSkyFileManager = blueSkyFileManager;