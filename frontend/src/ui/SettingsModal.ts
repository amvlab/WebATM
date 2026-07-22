import { connectionStatus } from '../core/ConnectionStatusService';
import {
    ServerConfigResponse,
    ServerControlResponse
} from '../data/types';
import { consoleManager } from './ConsoleManager';
import { modalManager } from './ModalManager';
import { serverManager } from './ServerManager';
import { logger, LogLevel } from '../utils/Logger';
import { storage } from '../utils/StorageManager';
import { themeManager, ThemePreference } from '../utils/ThemeManager';
import { isVisible, onDOMReady, setDisabled, setVisible } from '../utils/dom';

/**
 * Settings Modal Component
 * Handles BlueSky server configuration and map style settings
 */
export class SettingsModal {
    private modalId = 'settings-modal';
    private isInitialized = false;
    private currentServerIP: string = 'localhost'; // Will be updated from backend config
    private blueSkyConnected = false;
    private blueSkyServerRunning = false;
    // Integrated build only: when true the connectivity section is auto-managed
    // — the server host is fixed to wherever the backend lives (BlueSky runs in
    // the same container) and the manual Connect/Disconnect buttons are hidden,
    // because connecting follows the server lifecycle automatically. Activated
    // via enableIntegratedMode(); stays false in the default build.
    private integratedMode = false;

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
        themeSelect: HTMLSelectElement | null;
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
            developerToggle: null,
            themeSelect: null
        };

    constructor() {
        this.init();
    }

    private init(): void {
        if (this.isInitialized) return;
        onDOMReady(() => this.initializeElements());
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

        // Appearance controls
        this.elements.themeSelect = document.getElementById('theme-select') as HTMLSelectElement;

        // Register with modal manager
        modalManager.registerModal(this.modalId);

        // Reflect the active theme preference and react to changes
        this.initializeThemeControls();

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
        const config = logger.getConfig();
        if (this.elements.logLevelSelect) {
            this.elements.logLevelSelect.value = config.level.toString();
        }

        if (this.elements.logTimestampsCheckbox) {
            this.elements.logTimestampsCheckbox.checked = config.enableTimestamps;
        }

        if (this.elements.logPrefixesCheckbox) {
            this.elements.logPrefixesCheckbox.checked = config.enableComponentPrefixes;
        }
    }

    /**
     * Initialize the theme selector with the current preference and persist /
     * apply changes through ThemeManager.
     */
    private initializeThemeControls(): void {
        const select = this.elements.themeSelect;
        if (!select) return;

        select.value = themeManager.getPreference();

        select.addEventListener('change', (e) => {
            const value = (e.target as HTMLSelectElement).value as ThemePreference;
            themeManager.setPreference(value);
            logger.info('SettingsModal', `Theme changed to: ${value}`);
        });

        // Keep the dropdown in sync if the theme changes elsewhere (e.g. the OS
        // preference flips while "System" is selected).
        themeManager.subscribe((_resolved, preference) => {
            if (select.value !== preference) {
                select.value = preference;
            }
        });
    }

    /**
     * Bind logger-specific event handlers
     */
    private bindLoggerEventHandlers(): void {
        if (this.elements.logLevelSelect) {
            this.elements.logLevelSelect.addEventListener('change', (e) => {
                const target = e.target as HTMLSelectElement;
                const level = parseInt(target.value, 10) as LogLevel;
                logger.setLevel(level);
                logger.info('SettingsModal', `Log level changed to: ${logger.getLevelName(level)}`);
            });
        }

        if (this.elements.logTimestampsCheckbox) {
            this.elements.logTimestampsCheckbox.addEventListener('change', (e) => {
                const target = e.target as HTMLInputElement;
                logger.setTimestamps(target.checked);
                logger.info('SettingsModal', `Log timestamps ${target.checked ? 'enabled' : 'disabled'}`);
            });
        }

        if (this.elements.logPrefixesCheckbox) {
            this.elements.logPrefixesCheckbox.addEventListener('change', (e) => {
                const target = e.target as HTMLInputElement;
                logger.setComponentPrefixes(target.checked);
                logger.info('SettingsModal', `Component prefixes ${target.checked ? 'enabled' : 'disabled'}`);
            });
        }

        if (this.elements.resetLoggingButton) {
            this.elements.resetLoggingButton.addEventListener('click', () => {
                logger.resetConfig();
                this.initializeLoggerControls();
                logger.info('SettingsModal', 'Logging settings reset to defaults');
            });
        }

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
            const open = developerControls.classList.toggle('open');
            toggleButton.classList.toggle('open', open);
        }
    }

    private bindEventHandlers(): void {
        // The button that opens the modal is handled by Header.ts; this class
        // only handles the modal content.
        if (this.elements.connectButton) {
            this.elements.connectButton.addEventListener('click', () => this.connectToServer());
        }

        if (this.elements.disconnectButton) {
            this.elements.disconnectButton.addEventListener('click', () => this.disconnectFromServer());
        }

        if (this.elements.checkStatusButton) {
            this.elements.checkStatusButton.addEventListener('click', () => this.manualCheckServerStatus());
        }

        if (this.elements.cancelButton) {
            this.elements.cancelButton.addEventListener('click', () => this.close());
        }

        // Enter in the host field acts as a Connect click, so it must respect
        // the button's disabled/hidden state (server down, already connected,
        // or integrated mode).
        if (this.elements.serverIpInput) {
            this.elements.serverIpInput.addEventListener('keypress', (e) => {
                const connectButton = this.elements.connectButton;
                if (
                    e.key === 'Enter' &&
                    connectButton &&
                    !connectButton.disabled &&
                    isVisible(connectButton)
                ) {
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
        document.addEventListener('serverStatusUpdate', (event) => {
            this.handleServerStatusUpdate(event.detail);
        });

        // Keep button states in sync with the BlueSky connection state
        connectionStatus.subscribe((status) => {
            const wasBlueSkyConnected = this.blueSkyConnected;
            this.blueSkyConnected = status.blueSkyConnected;

            if (wasBlueSkyConnected !== this.blueSkyConnected) {
                this.updateConnectionButtons(this.blueSkyConnected);
                this.updateConnectButtonState();
            }
        });
    }

    /**
     * Open the settings modal. Settings are loaded by onBeforeOpen(), which
     * the modal manager fires on every open.
     */
    public open(): void {
        modalManager.open(this.modalId);
    }

    /**
     * Close the settings modal
     */
    public close(): void {
        modalManager.close(this.modalId);
    }

    /**
     * Refresh connection state, settings and server status on every open.
     */
    private async onBeforeOpen(): Promise<void> {
        this.blueSkyConnected = connectionStatus.getStatus().blueSkyConnected;

        await this.loadCurrentSettings();
        this.updateConnectionButtons(this.blueSkyConnected);

        await this.checkServerStatus();
        this.updateConnectButtonState();
    }

    /**
     * Load current settings into the modal
     */
    private async loadCurrentSettings(): Promise<void> {
        try {
            // Check saved server IP first, then fetch from backend. In the
            // integrated build ignore any saved IP and always take the backend's
            // configured host — BlueSky lives alongside the backend.
            let serverIp = this.integratedMode ? null : this.getSavedServerIP();
            if (!serverIp) {
                const response = await fetch('/api/server/config');
                if (response.ok) {
                    const config: ServerConfigResponse = await response.json();
                    serverIp = config.server_ip;
                }
            }

            if (serverIp) {
                this.currentServerIP = serverIp;
                if (this.elements.serverIpInput) {
                    this.elements.serverIpInput.value = serverIp;
                }
            }

        } catch (error) {
            logger.error('SettingsModal', 'Error loading server config:', error);
            // Only use localhost as final fallback if we can't reach backend
            if (this.elements.serverIpInput) {
                this.elements.serverIpInput.value = this.currentServerIP;
            }
        }

        // Re-assert the integrated-mode appearance after (re)populating the value.
        if (this.integratedMode) {
            this.applyIntegratedMode();
        }

        // Load current map style settings
        this.loadMapStyleSettings();
    }

    /**
     * Load map style settings
     */
    private loadMapStyleSettings(): void {
        if (!this.elements.mapStyleSelect) {
            logger.warn('SettingsModal', 'Map style select element not found');
            return;
        }

        // Saved map style from storage (same key as used in MapDisplay)
        const savedStyle = storage.get<string>('webatm-map-style');

        if (savedStyle) {
            const options = this.elements.mapStyleSelect.options;
            let matchFound = false;

            for (let i = 0; i < options.length; i++) {
                const option = options[i];

                // Direct match, or a MapTiler style where the saved value has
                // ?key=ABC123 and the option value ends with a bare ?key=
                if (
                    option.value === savedStyle ||
                    (option.value.endsWith('?key=') && savedStyle.startsWith(option.value))
                ) {
                    this.elements.mapStyleSelect.selectedIndex = i;
                    matchFound = true;
                    break;
                }
            }

            if (!matchFound) {
                // Not a predefined option — treat it as a custom style URL
                const customOption = Array.from(options).find(opt => opt.value === 'custom');
                if (customOption) {
                    this.elements.mapStyleSelect.value = 'custom';
                    const customInput = document.getElementById('custom-style-url-modal') as HTMLInputElement;
                    if (customInput) {
                        customInput.value = savedStyle;
                    }
                }
            }
        }

        // Notify the style selector's change handler so the custom-input and
        // "Delete Saved Style" controls match the option we just selected
        // programmatically (setting selectedIndex/value fires no change event).
        this.elements.mapStyleSelect.dispatchEvent(new Event('change'));
    }

    /**
     * Connect to server
     */
    private async connectToServer(hostOverride?: string): Promise<boolean> {
        const serverIp = hostOverride ?? (this.elements.serverIpInput?.value.trim() || 'localhost');

        try {
            this.currentServerIP = serverIp;
            this.setConnectButtonState('Connecting...', true);

            const response = await fetch('/api/server/config', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ server_ip: serverIp })
            });

            const result: ServerControlResponse = await response.json();

            if (result.success) {
                this.saveServerIP(serverIp);
                this.close();

                // Move focus back to command console
                const consoleInput = document.getElementById('console-input') as HTMLInputElement;
                if (consoleInput) {
                    consoleInput.focus();
                }
                return true;
            }

            consoleManager.error(`Connection failed: ${result.error}`);
            return false;
        } catch (error) {
            logger.error('SettingsModal', 'Error updating server settings:', error);
            consoleManager.error(`Connection error: ${(error as Error).message}`);
            return false;
        } finally {
            // Restore the label, then recompute enabled/disabled from the
            // actual server/connection state instead of unconditionally
            // re-enabling (the server may still be down).
            this.setConnectButtonState('Connect', false);
            this.updateConnectButtonState();
        }
    }

    /**
     * Connect to the currently-configured BlueSky host programmatically, without
     * any modal interaction. Used by the integrated build to auto-connect after
     * the server is started/restarted. Resolves true once the connection is
     * confirmed.
     */
    public connectToConfiguredServer(): Promise<boolean> {
        return this.connectToServer(this.currentServerIP);
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
                this.clearSavedServerIP();
                this.updateConnectionButtons(false);

                // Reset server status display to prompt user to check status;
                // the modal stays open after a disconnect.
                serverManager.resetStatus();
                this.blueSkyServerRunning = false;
            } else {
                consoleManager.error(`Disconnect failed: ${result.error}`);
            }
        } catch (error) {
            logger.error('SettingsModal', 'Error disconnecting:', error);
            consoleManager.error(`Disconnect error: ${(error as Error).message}`);
        }
    }

    /**
     * Disconnect from the BlueSky server programmatically, without any modal
     * interaction. Used by the integrated build to auto-disconnect after the
     * server is stopped/killed.
     */
    public disconnectFromConfiguredServer(): Promise<void> {
        return this.disconnectFromServer();
    }

    /**
     * Handle server status update event
     */
    private handleServerStatusUpdate(detail: { status: string; message: string }): void {
        this.blueSkyServerRunning = detail.status === 'running';
        this.updateConnectButtonState();
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
            setDisabled(this.elements.connectButton, shouldDisable);
        }
    }

    /**
     * Update connection button states
     * Shows Connect button when NOT connected, Disconnect button when connected
     * Disables hostname input when connected
     * Cancel button is always visible
     */
    private updateConnectionButtons(isConnected: boolean): void {
        // Integrated build: connecting/disconnecting is auto-managed from the
        // server lifecycle controls, so the manual buttons stay hidden and the
        // host stays locked regardless of connection state.
        if (this.integratedMode) {
            this.applyIntegratedMode();
            return;
        }

        if (this.elements.connectButton) {
            this.elements.connectButton.style.display = isConnected ? 'none' : 'inline-block';
        }

        if (this.elements.disconnectButton) {
            this.elements.disconnectButton.style.display = isConnected ? 'inline-block' : 'none';
        }

        // Disable hostname input when connected, enable when disconnected.
        // Not using the shared setDisabled() helper because this input uses
        // a text-input cursor + different opacity than the button convention.
        if (this.elements.serverIpInput) {
            const input = this.elements.serverIpInput;
            input.disabled = isConnected;
            input.style.opacity = isConnected ? '0.6' : '1';
            input.style.cursor = isConnected ? 'not-allowed' : 'text';
        }

        // Also update button state when connection status changes
        this.updateConnectButtonState();
    }

    /**
     * Switch the connectivity section into integrated mode (integrated build
     * only).
     *
     * In the integrated build BlueSky runs inside the same container as the
     * WebATM backend, so the connection host is always "wherever the backend
     * lives" and connecting/disconnecting follows the server lifecycle
     * automatically. Lock the host to the backend-reported value and hide the
     * manual Connect/Disconnect buttons, and keep it that way regardless of
     * connection state. Never called in the default build, so it stays a no-op
     * there.
     */
    public enableIntegratedMode(): void {
        if (this.integratedMode) return;
        this.integratedMode = true;
        onDOMReady(() => {
            this.applyIntegratedMode();
            // Pull the host from the backend so the field shows where BlueSky
            // actually lives (its configured host, e.g. localhost), ignoring any
            // IP a previous non-integrated session may have saved.
            void this.loadCurrentSettings();
        });
    }

    /**
     * Apply the integrated-mode appearance: lock the host input to the
     * backend's value and hide the manual Connect/Disconnect buttons (the
     * connection is managed automatically). Safe to call repeatedly.
     */
    private applyIntegratedMode(): void {
        const input = this.elements.serverIpInput;
        if (input) {
            input.disabled = true;
            input.style.opacity = '0.6';
            input.style.cursor = 'not-allowed';
            input.title = 'Server host is Fixed in WebATM Integrated.';
        }

        const help = input?.closest('.setting-group')?.querySelector('small.setting-help');
        if (help) {
            help.textContent = 'Server host is Fixed in WebATM Integrated.';
        }

        // Connecting/disconnecting is auto-managed from the server controls, so
        // the manual buttons aren't a user concern here.
        if (this.elements.connectButton) setVisible(this.elements.connectButton, false);
        if (this.elements.disconnectButton) setVisible(this.elements.disconnectButton, false);
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

    private static readonly SERVER_IP_KEY = 'bluesky-server-ip';

    /**
     * Get saved server IP from localStorage
     */
    private getSavedServerIP(): string | null {
        return storage.getStringWithLegacyMigration(
            SettingsModal.SERVER_IP_KEY,
            SettingsModal.SERVER_IP_KEY
        );
    }

    /**
     * Save server IP to localStorage
     */
    private saveServerIP(ip: string): void {
        storage.set(SettingsModal.SERVER_IP_KEY, ip);
    }

    /**
     * Clear saved server IP
     */
    private clearSavedServerIP(): void {
        storage.remove(SettingsModal.SERVER_IP_KEY);
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

}

// Export singleton instance
export const settingsModal = new SettingsModal();