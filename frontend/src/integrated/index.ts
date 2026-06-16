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
    // Expose the full server lifecycle from Settings too: inject Start / Stop /
    // Restart / Kill controls into the connectivity section before wiring, so
    // ProcessControlManager binds them alongside the Server Log toolbar buttons.
    injectSettingsServerControls();
    // Connecting/disconnecting is auto-managed in the integrated build: connect
    // the proxy to the local server after a start/restart and drop it after a
    // stop/kill, so the user never has to open Settings and click Connect.
    const controls = new ProcessControlManager(
        logTab,
        () => settingsModal.connectToConfiguredServer(),
        () => settingsModal.disconnectFromConfiguredServer(),
        // Reconcile the control status with the live BlueSky connection (the
        // same source the header reads) so the two never contradict — notably
        // after QUIT disconnects the proxy while the bundled server keeps running.
        connectionStatus,
    );

    // BlueSky runs inside this container alongside the backend, so the host is
    // fixed and the manual Connect/Disconnect buttons are hidden — connecting
    // follows the server lifecycle automatically.
    settingsModal.enableIntegratedMode();

    // For the same reason, file management is pre-wired to BlueSky's own
    // scenario/plugins/output directories by the integrated backend, so hide the
    // manual "BlueSky Base Directory" configuration — there's nothing to set.
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
