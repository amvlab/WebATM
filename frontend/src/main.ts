import { App } from './core/App';
import { echoManager } from './ui/EchoManager';
import { connectionStatus } from './core/ConnectionStatusService';
import { logger } from './utils/Logger';
import './ui/LogStreamManager';
import './ui/OutputFileBrowser';

/**
 * Entry point for WebATM TypeScript application
 *
 * This file serves as the main entry point that initializes the App class
 * when the DOM is ready, replacing the original JavaScript initialization.
 */

// Initialize application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    logger.info('main', 'DOM loaded, initializing WebATM...');

    const app = new App();

    // Make app and managers available globally for console and other components
    window.app = app;
    window.echoManager = echoManager;
    window.blueSkyApp = app;
    window.connectionStatus = connectionStatus;

    logger.info('main', 'Global debug helpers available: window.app, window.blueSkyApp, window.connectionStatus');

    app.initialize().then(() => {
        // Make console available globally for compatibility
        window.console_ui = app.getConsole();

        // Expose map instance globally for PanelResizer and debugging
        const mapDisplay = app.getMapDisplay();
        window.map = mapDisplay.getMap() ?? undefined;
        logger.info('main', 'Global map instance available: window.map');

        // Expose map control functions globally for HTML onclick handlers
        const mapControlsPanel = app.getMapControlsPanel();
        window.zoomIn = () => mapControlsPanel.zoomIn();
        window.zoomOut = () => mapControlsPanel.zoomOut();
        window.resetView = () => mapControlsPanel.resetView();

        logger.info('main', 'Global map control functions available: zoomIn, zoomOut, resetView');
    }).catch((error) => {
        logger.error('main', 'Failed to initialize WebATM:', error);
    });
});

// Handle any unhandled promise rejections
window.addEventListener('unhandledrejection', (event) => {
    logger.error('main', 'Unhandled promise rejection:', event.reason);
    event.preventDefault();
});

// Handle any unhandled errors
window.addEventListener('error', (event) => {
    logger.error('main', 'Unhandled error:', event.error);
});