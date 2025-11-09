import { connectionStatus } from '../core/ConnectionStatusService';
import {
    ServerConfigResponse,
    ServerControlResponse
} from '../data/types';
import { connectionManager } from './ConnectionManager';
import { consoleManager } from './ConsoleManager';
import { modalManager } from './ModalManager';
import { serverManager } from './ServerManager';
import { logger, LogLevel } from '../utils/Logger';
import { storage } from '../utils/StorageManager';

/**
 * Settings Modal Component
 * Handles BlueSky server configuration and map style settings
 */
export class SettingsModal {
    private modalId = 'settings-modal';
    private isInitialized = false;
    private currentServerIP: string = 'localhost'; // Will be updated from backend config
    private serverDisconnected = false;
    private blueSkyConnected = false;
    private blueSkyServerRunning = false;

    // Elements
    private elements: {
        modal: HTMLElement | null;
        serverIpInput: HTMLInputElement | null;
        connectButton: HTMLButtonElement | null;
        disconnectButton: HTMLButtonElement | null;
        cancelButton: HTMLButtonElement | null;
        checkStatusButton: HTMLButtonElement | null;
        mapStyleSelect: HTMLSelectElement | null;
        mapTilerApiKeyInput: HTMLInputElement | null;
        logLevelSelect: HTMLSelectElement | null;
        logTimestampsCheckbox: HTMLInputElement | null;
        logPrefixesCheckbox: HTMLInputElement | null;
        resetLoggingButton: HTMLButtonElement | null;
        developerToggle: HTMLButtonElement | null;
    } = {
            modal: null,
            serverIpInput: null,
            connectButton: null,
            disconnectButton: null,
            cancelButton: null,
            checkStatusButton: null,
            mapStyleSelect: null,
            mapTilerApiKeyInput: null,
            logLevelSelect: null,
            logTimestampsCheckbox: null,
            logPrefixesCheckbox: null,
            resetLoggingButton: null,
            developerToggle: null
        };

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
        // Get modal elements
        this.elements.modal = document.getElementById(this.modalId);
        this.elements.serverIpInput = document.getElementById('server-ip-input') as HTMLInputElement;
        this.elements.connectButton = document.getElementById('connect-server') as HTMLButtonElement;
        this.elements.disconnectButton = document.getElementById('disconnect-server') as HTMLButtonElement;
        this.elements.cancelButton = document.getElementById('cancel-server-settings') as HTMLButtonElement;
        this.elements.checkStatusButton = document.getElementById('check-server-status') as HTMLButtonElement;
        this.elements.mapStyleSelect = document.getElementById('map-style-select-modal') as HTMLSelectElement;
        this.elements.mapTilerApiKeyInput = document.getElementById('maptiler-api-key-input') as HTMLInputElement;

        // Get logger elements
        this.elements.logLevelSelect = document.getElementById('log-level-select') as HTMLSelectElement;
        this.elements.logTimestampsCheckbox = document.getElementById('log-timestamps') as HTMLInputElement;
        this.elements.logPrefixesCheckbox = document.getElementById('log-component-prefixes') as HTMLInputElement;
        this.elements.resetLoggingButton = document.getElementById('reset-logging-btn') as HTMLButtonElement;
        this.elements.developerToggle = document.getElementById('developer-toggle') as HTMLButtonElement;

        // Register with modal manager
        modalManager.registerModal(this.modalId);

        // Initialize logger controls with current settings
        this.initializeLoggerControls();

        // Bind event handlers
        this.bindEventHandlers();

        this.isInitialized = true;
    }

    /**
     * Initialize logger controls with current settings
     */
    private initializeLoggerControls(): void {
        if (this.elements.logLevelSelect) {
            this.elements.logLevelSelect.value = logger.getLevel().toString();
        }
        
        if (this.elements.logTimestampsCheckbox) {
            this.elements.logTimestampsCheckbox.checked = logger.getConfig().enableTimestamps;
        }
        
        if (this.elements.logPrefixesCheckbox) {
            this.elements.logPrefixesCheckbox.checked = logger.getConfig().enableComponentPrefixes;
        }
    }

    /**
     * Bind logger-specific event handlers
     */
    private bindLoggerEventHandlers(): void {
        // Log level select
        if (this.elements.logLevelSelect) {
            this.elements.logLevelSelect.addEventListener('change', (e) => {
                const target = e.target as HTMLSelectElement;
                const level = parseInt(target.value, 10) as LogLevel;
                logger.setLevel(level);
                logger.info('SettingsModal', `Log level changed to: ${logger.getLevelName(level)}`);
            });
        }

        // Timestamps checkbox
        if (this.elements.logTimestampsCheckbox) {
            this.elements.logTimestampsCheckbox.addEventListener('change', (e) => {
                const target = e.target as HTMLInputElement;
                logger.setTimestamps(target.checked);
                logger.info('SettingsModal', `Log timestamps ${target.checked ? 'enabled' : 'disabled'}`);
            });
        }

        // Component prefixes checkbox
        if (this.elements.logPrefixesCheckbox) {
            this.elements.logPrefixesCheckbox.addEventListener('change', (e) => {
                const target = e.target as HTMLInputElement;
                logger.setComponentPrefixes(target.checked);
                logger.info('SettingsModal', `Component prefixes ${target.checked ? 'enabled' : 'disabled'}`);
            });
        }

        // Reset logging button
        if (this.elements.resetLoggingButton) {
            this.elements.resetLoggingButton.addEventListener('click', () => {
                logger.resetConfig();
                this.initializeLoggerControls(); // Update UI controls
                logger.info('SettingsModal', 'Logging settings reset to defaults');
            });
        }

        // Developer toggle button
        if (this.elements.developerToggle) {
            this.elements.developerToggle.addEventListener('click', () => {
                this.toggleDeveloperSection();
            });
        }
    }

    /**
     * Toggle developer section visibility
     */
    private toggleDeveloperSection(): void {
        const developerControls = document.getElementById('developer-controls');
        const toggleButton = this.elements.developerToggle;
        
        if (developerControls && toggleButton) {
            const isVisible = developerControls.style.display !== 'none';
            developerControls.style.display = isVisible ? 'none' : 'block';
            toggleButton.textContent = isVisible ? 'Developer ▼' : 'Developer ▲';
        }
    }

    private bindEventHandlers(): void {
        // Settings button is now handled by Header.ts to avoid duplicate handlers
        // SettingsModal only handles the modal content, not the button that opens it

        // Connect to server
        if (this.elements.connectButton) {
            this.elements.connectButton.addEventListener('click', () => this.connectToServer());
        }

        // Disconnect from server
        if (this.elements.disconnectButton) {
            this.elements.disconnectButton.addEventListener('click', () => this.disconnectFromServer());
        }

        // Check server status
        if (this.elements.checkStatusButton) {
            this.elements.checkStatusButton.addEventListener('click', () => this.manualCheckServerStatus());
        }

        // Cancel/close modal
        if (this.elements.cancelButton) {
            this.elements.cancelButton.addEventListener('click', () => this.close());
        }

        // Handle Enter key in server IP input
        if (this.elements.serverIpInput) {
            this.elements.serverIpInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.connectToServer();
                }
            });
        }

        // Logger event handlers
        this.bindLoggerEventHandlers();

        // Modal event handlers
        modalManager.on(this.modalId, (eventType) => {
            if (eventType === 'beforeOpen') {
                this.onBeforeOpen();
            }
        });

        // Listen for server status updates
        document.addEventListener('serverStatusUpdate', (event: Event) => {
            const customEvent = event as CustomEvent;
            this.handleServerStatusUpdate(customEvent.detail);
        });

        // Subscribe to ConnectionStatusService for BlueSky connection state
        connectionStatus.subscribe((status) => {
            // Update local state based on connection status
            const wasBlueSkyConnected = this.blueSkyConnected;
            this.blueSkyConnected = status.blueSkyConnected;

            // Update button states when connection status changes
            if (wasBlueSkyConnected !== this.blueSkyConnected) {
                logger.debug('SettingsModal', `BlueSky connection status changed: ${wasBlueSkyConnected} → ${this.blueSkyConnected}`);
                this.updateConnectionButtons(this.blueSkyConnected);
                this.updateConnectButtonState();

                // Log button state after update
                logger.debug('SettingsModal', `After connection change - Connect button visible: ${this.elements.connectButton?.style.display !== 'none'}, enabled: ${!this.elements.connectButton?.disabled}`);
            }
        });
    }

    /**
     * Open the settings modal
     */
    public async open(): Promise<void> {
        try {
            // Load current settings before opening
            await this.loadCurrentSettings();
            modalManager.open(this.modalId);
        } catch (error) {
            logger.error('SettingsModal', 'Error opening settings modal:', error);
        }
    }

    /**
     * Close the settings modal
     */
    public close(): void {
        modalManager.close(this.modalId);
    }

    /**
     * Handle before modal open event
     */
    private async onBeforeOpen(): Promise<void> {
        // Get fresh connection state from ConnectionStatusService
        const connectionState = connectionStatus.getStatus();
        this.blueSkyConnected = connectionState.blueSkyConnected;

        logger.debug('SettingsModal', `Modal opening - BlueSky connected: ${this.blueSkyConnected}`);

        await this.loadCurrentSettings();

        // Update buttons based on fresh connection state
        this.updateConnectionButtons(this.blueSkyConnected);

        await this.checkServerStatus();

        // Update button state based on current server status
        this.updateConnectButtonState();

        logger.debug('SettingsModal', `Modal opened - Connect button visible: ${this.elements.connectButton?.style.display !== 'none'}, enabled: ${!this.elements.connectButton?.disabled}`);
    }

    /**
     * Load current settings into the modal
     */
    private async loadCurrentSettings(): Promise<void> {
        try {
            // Check saved server IP first, then fetch from backend
            let serverIp = this.getSavedServerIP();
            if (!serverIp) {
                const response = await fetch('/api/server/config');
                if (response.ok) {
                    const config: ServerConfigResponse = await response.json();
                    serverIp = config.server_ip;
                    // Update our current server IP to match backend's default
                    if (serverIp) {
                        this.currentServerIP = serverIp;
                    }
                }
            }

            if (this.elements.serverIpInput && serverIp) {
                this.elements.serverIpInput.value = serverIp;
            }

        } catch (error) {
            logger.error('SettingsModal', 'Error loading server config:', error);
            // Only use localhost as final fallback if we can't reach backend
            if (this.elements.serverIpInput) {
                this.elements.serverIpInput.value = this.currentServerIP;
            }
        }

        // Load current map style settings
        this.loadMapStyleSettings();
    }

    /**
     * Load map style settings
     */
    private loadMapStyleSettings(): void {
        logger.debug('SettingsModal', 'Loading map style settings...');
        
        if (!this.elements.mapStyleSelect) {
            logger.warn('SettingsModal', 'Map style select element not found');
            return;
        }

        // Get saved map style from storage (same key as used in MapDisplay)
        const savedStyle = storage.get<string>('webatm-map-style');
        
        if (savedStyle) {
            logger.debug('SettingsModal', 'Found saved map style:', savedStyle);
            
            // Try to find and select the matching option
            const options = this.elements.mapStyleSelect.options;
            let matchFound = false;
            
            for (let i = 0; i < options.length; i++) {
                const option = options[i];
                
                // Direct match
                if (option.value === savedStyle) {
                    this.elements.mapStyleSelect.selectedIndex = i;
                    matchFound = true;
                    logger.debug('SettingsModal', 'Map style option selected (direct match):', option.text);
                    break;
                }
                
                // Handle MapTiler styles with API keys
                // Saved style has ?key=ABC123, option value has ?key=
                if (option.value.endsWith('?key=') && savedStyle.startsWith(option.value)) {
                    this.elements.mapStyleSelect.selectedIndex = i;
                    matchFound = true;
                    logger.debug('SettingsModal', 'Map style option selected (API key match):', option.text);
                    break;
                }
            }
            
            if (!matchFound) {
                logger.debug('SettingsModal', 'Saved style not found in predefined options, might be custom style');
                // Set to custom option if available or leave as default
                const customOption = Array.from(options).find(opt => opt.value === 'custom');
                if (customOption) {
                    this.elements.mapStyleSelect.value = 'custom';
                    // Also populate custom URL input if present
                    const customInput = document.getElementById('custom-style-url-modal') as HTMLInputElement;
                    if (customInput) {
                        customInput.value = savedStyle;
                    }
                }
            }
        } else {
            logger.debug('SettingsModal', 'No saved map style found, using default selection');
        }
    }

    /**
     * Connect to server
     */
    private async connectToServer(): Promise<void> {
        const serverIp = this.elements.serverIpInput?.value.trim() || 'localhost';

        try {
            // Store the server IP for status display
            this.currentServerIP = serverIp;

            // Show loading state
            this.setConnectButtonState('Connecting...', true);

            // Note: "Connecting..." message is automatically logged by ConnectionStatusService

            const response = await fetch('/api/server/config', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ server_ip: serverIp })
            });

            const result: ServerControlResponse = await response.json();

            if (result.success) {
                // Reset disconnection flag when reconnecting
                this.serverDisconnected = false;

                // Save server IP to session storage on successful connection
                this.saveServerIP(serverIp);
                // Note: Connection success message is automatically logged by ConnectionStatusService
                this.close();

                // Update BlueSky connection status based on nodes
                this.updateBlueSkyConnectionStatus();

                // Schedule auto-switch check after a brief delay to allow node info to arrive
                setTimeout(() => {
                    // This would call the main app's auto-switch logic
                    this.handleAutoNodeSwitching();
                }, 500);

                // Move focus back to command console
                const consoleInput = document.getElementById('console-input') as HTMLInputElement;
                if (consoleInput) {
                    consoleInput.focus();
                }
            } else {
                this.addConsoleMessage(`Connection failed: ${result.error}`, 'console-error');
                this.updateConnectionStatus(false);
            }
        } catch (error) {
            logger.error('SettingsModal', 'Error updating server settings:', error);
            this.addConsoleMessage(`Connection error: ${(error as Error).message}`, 'console-error');
            this.updateConnectionStatus(false);
        } finally {
            // Reset button state
            this.setConnectButtonState('Connect', false);
        }
    }

    /**
     * Disconnect from server
     */
    private async disconnectFromServer(): Promise<void> {
        try {
            const response = await fetch('/api/server/disconnect', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            const result: ServerControlResponse = await response.json();
            if (result.success) {
                // Note: Disconnection message is automatically logged by ConnectionStatusService
                this.updateConnectionStatus(false);
                this.clearSavedServerIP();

                // Immediately update button visibility after disconnect
                logger.debug('SettingsModal', 'Disconnect successful - updating buttons');
                this.updateConnectionButtons(false);

                // Reset server status display to prompt user to check status
                serverManager.resetStatus();
                this.blueSkyServerRunning = false;

                // Settings modal remains open after disconnect
            } else {
                this.addConsoleMessage(`Disconnect failed: ${result.error}`, 'console-error');
            }
        } catch (error) {
            logger.error('SettingsModal', 'Error disconnecting:', error);
            this.addConsoleMessage(`Disconnect error: ${(error as Error).message}`, 'console-error');
        }
    }

    /**
     * Handle server status update event
     */
    private handleServerStatusUpdate(detail: { status: string; message: string }): void {
        const isRunning = detail.status === 'running';
        this.blueSkyServerRunning = isRunning;

        // Update connect button state based on server status
        this.updateConnectButtonState();

        logger.debug('SettingsModal', `Server status updated: ${detail.status} - Connect button ${isRunning ? 'enabled' : 'disabled'}`);
    }

    /**
     * Update connect button state based on server status
     * Connect button should be:
     * - Visible when NOT connected to BlueSky
     * - Enabled when BlueSky server is running
     * - Disabled (greyed out) when BlueSky server is stopped or down
     */
    private updateConnectButtonState(): void {
        if (this.elements.connectButton) {
            const shouldDisable = !this.blueSkyServerRunning || this.blueSkyConnected;

            this.elements.connectButton.disabled = shouldDisable;

            if (shouldDisable) {
                this.elements.connectButton.classList.add('disabled');
                this.elements.connectButton.style.opacity = '0.5';
                this.elements.connectButton.style.cursor = 'not-allowed';
            } else {
                this.elements.connectButton.classList.remove('disabled');
                this.elements.connectButton.style.opacity = '1';
                this.elements.connectButton.style.cursor = 'pointer';
            }
        }
    }

    /**
     * Update connection button states
     * Shows Connect button when NOT connected, Disconnect button when connected
     * Disables hostname input when connected
     * Cancel button is always visible
     */
    private updateConnectionButtons(isConnected: boolean): void {
        logger.debug('SettingsModal', `updateConnectionButtons called - isConnected: ${isConnected}`);

        if (this.elements.connectButton) {
            const newDisplay = isConnected ? 'none' : 'inline-block';
            logger.debug('SettingsModal', `Setting Connect button display to: ${newDisplay}`);
            this.elements.connectButton.style.display = newDisplay;
        } else {
            logger.warn('SettingsModal', 'Connect button element not found!');
        }

        if (this.elements.disconnectButton) {
            const newDisplay = isConnected ? 'inline-block' : 'none';
            logger.debug('SettingsModal', `Setting Disconnect button display to: ${newDisplay}`);
            this.elements.disconnectButton.style.display = newDisplay;
        } else {
            logger.warn('SettingsModal', 'Disconnect button element not found!');
        }

        // Disable hostname input when connected, enable when disconnected
        if (this.elements.serverIpInput) {
            this.elements.serverIpInput.disabled = isConnected;
            if (isConnected) {
                this.elements.serverIpInput.style.opacity = '0.6';
                this.elements.serverIpInput.style.cursor = 'not-allowed';
            } else {
                this.elements.serverIpInput.style.opacity = '1';
                this.elements.serverIpInput.style.cursor = 'text';
            }
            logger.debug('SettingsModal', `Hostname input ${isConnected ? 'disabled' : 'enabled'}`);
        }

        // Also update button state when connection status changes
        this.updateConnectButtonState();
    }

    /**
     * Set connect button state
     */
    private setConnectButtonState(text: string, disabled: boolean): void {
        if (this.elements.connectButton) {
            this.elements.connectButton.textContent = text;
            this.elements.connectButton.disabled = disabled;
        }
    }

    /**
     * Get saved server IP from localStorage
     */
    private getSavedServerIP(): string | null {
        return localStorage.getItem('bluesky-server-ip');
    }

    /**
     * Save server IP to localStorage
     */
    private saveServerIP(ip: string): void {
        localStorage.setItem('bluesky-server-ip', ip);
    }

    /**
     * Clear saved server IP
     */
    private clearSavedServerIP(): void {
        localStorage.removeItem('bluesky-server-ip');
    }

    /**
     * Check server status
     * @param hostname Optional hostname to check (defaults to current server input value)
     */
    private async checkServerStatus(hostname?: string): Promise<void> {
        try {
            // If no hostname provided, use the current value in the input field
            const checkHostname = hostname || this.elements.serverIpInput?.value.trim() || 'localhost';

            // Use ServerManager to check status and update display
            await serverManager.checkServerStatus(checkHostname);

            // Update local state from ServerManager
            const currentStatus = serverManager.getServerStatus();
            this.blueSkyServerRunning = currentStatus === 'running';

            logger.debug('SettingsModal', `Server status checked for ${checkHostname}: ${currentStatus}`);
        } catch (error) {
            logger.error('SettingsModal', 'Error checking server status:', error);
            this.blueSkyServerRunning = false;
        }
    }

    /**
     * Manual server status check triggered by "Check Status" button
     * Checks the hostname currently entered in the input field
     */
    private async manualCheckServerStatus(): Promise<void> {
        try {
            // Get hostname from input field
            const hostname = this.elements.serverIpInput?.value.trim() || 'localhost';

            // Disable button and show checking state
            if (this.elements.checkStatusButton) {
                this.elements.checkStatusButton.disabled = true;
                this.elements.checkStatusButton.textContent = 'Checking...';
            }

            logger.info('SettingsModal', `Manually checking server status for: ${hostname}`);

            // Use ServerManager to check status and update display
            await this.checkServerStatus(hostname);

            // Update button state based on result
            this.updateConnectButtonState();
        } catch (error) {
            logger.error('SettingsModal', 'Error during manual status check:', error);
        } finally {
            // Re-enable button
            if (this.elements.checkStatusButton) {
                this.elements.checkStatusButton.disabled = false;
                this.elements.checkStatusButton.textContent = 'Check Status';
            }
        }
    }

    /**
     * Add message to console
     */
    private addConsoleMessage(message: string, type: string): void {
        // Use the TypeScript console manager
        switch (type) {
            case 'console-error':
                consoleManager.error(message);
                break;
            case 'console-warning':
                consoleManager.warning(message);
                break;
            case 'console-success':
                consoleManager.success(message);
                break;
            case 'console-info':
            default:
                consoleManager.info(message);
                break;
        }
    }

    /**
     * Update connection status
     */
    private updateConnectionStatus(connected: boolean): void {
        this.blueSkyConnected = connected;

        // Use the TypeScript connection manager
        connectionManager.updateBlueSkyConnection(connected);

        // Update server IP in connection manager
        connectionManager.setServerIP(this.currentServerIP);
    }

    /**
     * Update BlueSky connection status
     */
    private updateBlueSkyConnectionStatus(): void {
        // This can be extended to check actual BlueSky connection state
        // For now, we'll emit a custom event that other components can listen to
        const event = new CustomEvent('blueSkyConnectionUpdate', {
            detail: { connected: this.blueSkyConnected }
        });
        document.dispatchEvent(event);
    }

    /**
     * Handle auto node switching
     */
    private handleAutoNodeSwitching(): void {
        // Emit event for auto node switching logic
        const event = new CustomEvent('autoNodeSwitchCheck', {
            detail: { serverIP: this.currentServerIP }
        });
        document.dispatchEvent(event);
    }

    /**
     * Public methods for external access
     */
    public setBlueSkyConnected(connected: boolean): void {
        this.blueSkyConnected = connected;
        this.updateConnectionButtons(connected);
    }

    public setServerDisconnected(disconnected: boolean): void {
        this.serverDisconnected = disconnected;
    }

    public getCurrentServerIP(): string {
        return this.currentServerIP;
    }
}

// Export singleton instance
export const settingsModal = new SettingsModal();