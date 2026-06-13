/**
 * Single source of truth for everything WebATM attaches to `window`.
 *
 * These globals exist for HTML onclick handlers, cross-module singletons
 * that predate dependency injection, and debugging from the browser
 * console. New code should prefer constructor injection over adding
 * entries here.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { App } from '../core/App';
import type { ConnectionStatusService } from '../core/ConnectionStatusService';
import type { Console } from '../ui/Console';
import type { EchoManager } from '../ui/EchoManager';
import type { BlueSkyFileManager } from '../ui/BlueSkyFileManager';
import type { LogStreamManager } from '../ui/LogStreamManager';
import type { OutputFileBrowser } from '../ui/OutputFileBrowser';
import type { PanelResizer } from '../ui/panels/PanelResizer';
import type { AircraftClickEvent } from '../ui/map/aircraft/AircraftInteractionManager';
import type {
    ConnectionStatusChangedDetail,
    ConnectionUpdateDetail,
    NodeInfoUpdateDetail,
    ServerStatusUpdateDetail,
} from '../data/types';

declare global {
    interface Window {
        // Application singletons (set in main.ts once the app boots)
        app?: App;
        blueSkyApp?: App;
        echoManager?: EchoManager;
        connectionStatus?: ConnectionStatusService;
        console_ui?: Console;
        map?: MapLibreMap;

        // Module-level singletons assigned where they are defined
        panelResizer?: PanelResizer;
        outputFileBrowser?: OutputFileBrowser;
        blueSkyFileManager?: BlueSkyFileManager;
        logStreamManager?: LogStreamManager;

        // HTML onclick handlers (wired in main.ts)
        zoomIn?: () => void;
        zoomOut?: () => void;
        resetView?: () => void;

        // Guard so the pmtiles:// protocol is registered once per page
        __webatmPmtilesRegistered__?: boolean;
    }

    // Typed payloads for the app's document-level CustomEvents, so
    // addEventListener callbacks get `e.detail` types without casts.
    interface DocumentEventMap {
        'webConnectionUpdate': CustomEvent<ConnectionUpdateDetail>;
        'blueSkyConnectionUpdate': CustomEvent<ConnectionUpdateDetail>;
        'serverStatusUpdate': CustomEvent<ServerStatusUpdateDetail>;
        'nodeInfoUpdate': CustomEvent<NodeInfoUpdateDetail>;
        'connectionStatusChanged': CustomEvent<ConnectionStatusChangedDetail>;
        'aircraft-single-click': CustomEvent<AircraftClickEvent>;
        'aircraft-double-click': CustomEvent<AircraftClickEvent>;
        'consoleMessage': CustomEvent<{ message: string; type: string }>;
        'echoMessage': CustomEvent<{ message: string; type: string }>;
    }
}

export {};
