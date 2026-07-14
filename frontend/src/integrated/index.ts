import type { App } from '../core/App';
import { connectionStatus } from '../core/ConnectionStatusService';
import { blueSkyFileManager } from '../ui/BlueSkyFileManager';
import { settingsModal } from '../ui/SettingsModal';
import { logger } from '../utils/Logger';
import { ProcessControlManager } from './ProcessControlManager';
import { ServerLogStreamManager } from './ServerLogStreamManager';
import { injectSettingsServerControls } from './settingsServerControls';

/**
 * Entry point for the integrated feature set (BlueSky server lifecycle controls
 * + live server-log tab). Loaded lazily from main.ts via a guarded dynamic
 * import that only exists in the `webatm-integrated` build.
 */

let registered = false;

export function registerIntegrated(app: App): void {
    if (registered) return;
    registered = true;

    const socket = app.getSocketManager().getSocket();
    const logTab = new ServerLogStreamManager(socket);
    // Inject the Settings-modal lifecycle controls before wiring, so
    // ProcessControlManager binds them alongside the Server Log toolbar buttons.
    injectSettingsServerControls();
    const controls = new ProcessControlManager(
        logTab,
        // The proxy connection follows the server lifecycle automatically:
        // connect after a start/restart, disconnect after a stop/kill.
        () => settingsModal.connectToConfiguredServer(),
        () => settingsModal.disconnectFromConfiguredServer(),
        connectionStatus,
    );

    // BlueSky runs inside this container, so the host is fixed and file
    // management is pre-wired to its scenario/plugins/output directories —
    // hide the manual connect and base-path controls.
    settingsModal.enableIntegratedMode();
    blueSkyFileManager.enableIntegratedMode();

    window.serverLogStreamManager = logTab;
    window.processControlManager = controls;

    logger.info('integrated', 'BlueSky server controls + live log tab enabled');
}

declare global {
    interface Window {
        serverLogStreamManager?: ServerLogStreamManager;
        processControlManager?: ProcessControlManager;
    }
}
