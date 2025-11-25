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
}

interface ListFilesResponse {
    success: boolean;
    file_type: string;
    files: UploadedFile[];
    base_path: string;
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
        this.checkCurrentStatus();
    }

    private setupEventHandlers(): void {
        // Configure base path button
        const configureBtn = document.getElementById('configure-base-path-btn');
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
        viewFileTypeSelect?.addEventListener('change', () => this.refreshFileList());

        // Close button handlers
        const closeFooterBtn = document.getElementById('upload-scenario-close-footer');
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
        // Update base path input
        const basePathInput = document.getElementById('bluesky-base-path-input') as HTMLInputElement;
        if (basePathInput && status.base_path) {
            basePathInput.value = status.base_path;
        }

        // Show status
        const statusDiv = document.getElementById('base-path-status');
        if (statusDiv && status.derived_paths) {
            document.getElementById('scenario-path-display')!.textContent = status.derived_paths.scenario;
            document.getElementById('plugins-path-display')!.textContent = status.derived_paths.plugins;
            document.getElementById('settings-path-display')!.textContent = status.derived_paths.settings;
            statusDiv.style.display = 'block';
        }

        // Show upload and management sections
        document.getElementById('file-upload-section')!.style.display = 'block';
        document.getElementById('file-management-section')!.style.display = 'block';

        this.refreshFileList();
    }

    private updateUIForUnconfiguredState(): void {
        document.getElementById('base-path-status')!.style.display = 'none';
        document.getElementById('file-upload-section')!.style.display = 'none';
        document.getElementById('file-management-section')!.style.display = 'none';
    }

    private async configureBasePath(): Promise<void> {
        const basePathInput = document.getElementById('bluesky-base-path-input') as HTMLInputElement;
        const basePath = basePathInput.value.trim();

        if (!basePath) {
            this.showStatus('Please enter a base path', 'error');
            return;
        }

        const configureBtn = document.getElementById('configure-base-path-btn') as HTMLButtonElement;
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
                
                // Update UI
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
            const response = await fetch(`/api/bluesky/list/${fileType}`);
            const result: ListFilesResponse = await response.json();

            if (result.success) {
                this.renderFileList(result.files, fileType);
            } else {
                fileListDiv.innerHTML = `<div style="padding: 16px; text-align: center; color: #f44336;">Error loading files</div>`;
            }
        } catch (error) {
            logger.error('BlueSkyFileManager', 'Failed to load file list:', error);
            fileListDiv.innerHTML = `<div style="padding: 16px; text-align: center; color: #f44336;">Failed to load files</div>`;
        }
    }

    private renderFileList(files: UploadedFile[], fileType: string): void {
        const fileListDiv = document.getElementById('file-list');
        if (!fileListDiv) return;

        if (files.length === 0) {
            fileListDiv.innerHTML = `<div style="padding: 16px; text-align: center; color: #666;">No ${fileType} files uploaded</div>`;
            return;
        }

        const fileItems = files.map(file => {
            const modifiedDate = new Date(file.modified * 1000).toLocaleDateString();
            const fileSizeKB = Math.round(file.size / 1024);
            
            return `
                <div style="padding: 8px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-weight: bold;">${file.filename}</div>
                        <div style="font-size: 11px; color: #888;">${fileSizeKB} KB • ${modifiedDate}</div>
                    </div>
                    <button class="btn-secondary" onclick="blueSkyFileManager.deleteFile('${fileType}', '${file.filename}')" style="padding: 4px 8px; font-size: 11px;">
                        🗑️ Delete
                    </button>
                </div>
            `;
        }).join('');

        fileListDiv.innerHTML = fileItems;
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

    private closeModal(): void {
        const modal = document.getElementById('upload-scenario-modal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    public openModal(): void {
        const modal = document.getElementById('upload-scenario-modal');
        if (modal) {
            modal.style.display = 'block';
            this.checkCurrentStatus(); // Refresh status when opening
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