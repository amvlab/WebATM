/**
 * Panel Resizing Module
 * Manages interactive panel resizing with drag handles for the BlueSky Web Client UI
 * Includes persistent storage of panel sizes using localStorage
 */

import { storage } from '../../utils/StorageManager';
import { PanelLayoutState } from '../../data/types';
import { logger } from '../../utils/Logger';

interface Position {
    x: number;
    y: number;
}

interface PanelSizes {
    leftWidth?: number;
    rightWidth?: number;
    totalWidth?: number;
    topHeight?: number;
    bottomHeight?: number;
    totalHeight?: number;
}

interface PanelConfig {
    leftPanel?: HTMLElement | null;
    rightPanel?: HTMLElement | null;
    topPanel?: HTMLElement | null;
    bottomPanel?: HTMLElement | null;
    direction: 'horizontal' | 'vertical';
    minLeft?: number;
    maxLeft?: number;
    minRight?: number;
    maxRight?: number;
    minTop?: number;
    maxTop?: number;
    minBottom?: number;
    maxBottom?: number;
}

interface PanelConfigs {
    [key: string]: PanelConfig;
}

interface MapInstance {
    resize(): void;
}

interface WindowWithMap extends Window {
    map?: MapInstance;
    panelResizer?: PanelResizer;
}

declare const window: WindowWithMap;

export class PanelResizer {
    private static readonly STORAGE_KEY = 'panel-layout';
    private static readonly LAYOUT_VERSION = '1.0';

    private isDragging: boolean = false;
    private currentHandle: HTMLElement | null = null;
    private startPos: Position = { x: 0, y: 0 };
    private startSizes: PanelSizes = {};
    private handles: NodeListOf<Element> | null = null;
    private panelConfigs: PanelConfigs = {};

    constructor() {
        this.initializeResizers();
        this.setupEventListeners();
        this.loadPanelSizes();
    }

    private initializeResizers(): void {
        // Get all resize handles
        this.handles = document.querySelectorAll('.resize-handle');

        // Define panel configurations
        this.panelConfigs = {
            'left-map': {
                leftPanel: document.querySelector('.left-panel') as HTMLElement | null,
                rightPanel: document.querySelector('.map-container') as HTMLElement | null,
                direction: 'horizontal',
                minLeft: 200,
                maxLeft: 400,
                minRight: 300
            },
            'map-right': {
                leftPanel: document.querySelector('.map-container') as HTMLElement | null,
                rightPanel: document.querySelector('.right-panel') as HTMLElement | null,
                direction: 'horizontal',
                minLeft: 300,
                minRight: 200,
                maxRight: 400
            },
            'content-console': {
                topPanel: document.querySelector('.content-area') as HTMLElement | null,
                bottomPanel: document.querySelector('.console-container') as HTMLElement | null,
                direction: 'vertical',
                minTop: 200,
                minBottom: 120,
                maxBottom: 400
            },
            'console-echo': {
                leftPanel: document.querySelector('.console-section') as HTMLElement | null,
                rightPanel: document.querySelector('.echo-section') as HTMLElement | null,
                direction: 'horizontal',
                minLeft: 200,
                minRight: 150
            },
            'traffic-aircraft': {
                topPanel: document.querySelector('.traffic-panel') as HTMLElement | null,
                bottomPanel: document.querySelector('.aircraft-panel') as HTMLElement | null,
                direction: 'vertical',
                minTop: 120,
                minBottom: 100,
                maxTop: 400,
                maxBottom: 300
            },
            'aircraft-conflicts': {
                topPanel: document.querySelector('.aircraft-panel') as HTMLElement | null,
                bottomPanel: document.querySelector('.conflicts-panel') as HTMLElement | null,
                direction: 'vertical',
                minTop: 100,
                minBottom: 80,
                maxTop: 300,
                maxBottom: 250
            },
            'nodes-mapview': {
                topPanel: document.querySelector('.node-panel') as HTMLElement | null,
                bottomPanel: document.querySelector('.nav-panel') as HTMLElement | null,
                direction: 'vertical',
                minTop: 160,
                minBottom: 120,
                maxTop: 500,
                maxBottom: 250
            },
            'mapview-display': {
                topPanel: document.querySelector('.nav-panel') as HTMLElement | null,
                bottomPanel: document.querySelector('.display-panel') as HTMLElement | null,
                direction: 'vertical',
                minTop: 120,
                minBottom: 200,
                maxTop: 250,
                maxBottom: 500
            }
        };
    }

    private setupEventListeners(): void {
        // Add mouse events to each handle
        if (this.handles) {
            this.handles.forEach(handle => {
                handle.addEventListener('mousedown', ((e: MouseEvent) => this.onMouseDown(e)) as EventListener);
            });
        }

        // Global mouse events
        document.addEventListener('mousemove', ((e: MouseEvent) => this.onMouseMove(e)) as EventListener);
        document.addEventListener('mouseup', ((e: MouseEvent) => this.onMouseUp(e)) as EventListener);

        // Prevent text selection during resize
        document.addEventListener('selectstart', (e: Event) => {
            if (this.isDragging) {
                e.preventDefault();
            }
        });
    }

    private onMouseDown(e: MouseEvent): void {
        e.preventDefault();

        this.isDragging = true;
        this.currentHandle = e.target as HTMLElement;
        this.startPos = { x: e.clientX, y: e.clientY };

        // Add resizing class for visual feedback
        this.currentHandle.classList.add('resizing');

        // Get the target configuration
        const target = this.currentHandle.getAttribute('data-target');
        if (!target) return;

        const config = this.panelConfigs[target];

        if (config) {
            this.startSizes = this.getCurrentSizes(config);
        }

        // Change cursor globally and prevent text selection
        document.body.style.cursor = config.direction === 'horizontal' ? 'col-resize' : 'row-resize';
        document.body.classList.add('no-select');

        // Prevent map interactions during resize
        const mapElement = document.getElementById('map');
        if (mapElement) {
            mapElement.style.pointerEvents = 'none';
        }
    }

    private onMouseMove(e: MouseEvent): void {
        if (!this.isDragging || !this.currentHandle) return;

        e.preventDefault();

        const target = this.currentHandle.getAttribute('data-target');
        if (!target) return;

        const config = this.panelConfigs[target];

        if (!config) return;

        if (config.direction === 'horizontal') {
            this.handleHorizontalResize(e, config);
        } else {
            this.handleVerticalResize(e, config);
        }
    }

    private onMouseUp(e: MouseEvent): void {
        if (!this.isDragging) return;

        this.isDragging = false;

        if (this.currentHandle) {
            this.currentHandle.classList.remove('resizing');
            this.currentHandle = null;
        }

        // Reset cursor and re-enable text selection
        document.body.style.cursor = '';
        document.body.classList.remove('no-select');

        // Re-enable map interactions
        const mapElement = document.getElementById('map');
        if (mapElement) {
            mapElement.style.pointerEvents = '';
        }

        // Trigger map resize if MapLibre instance exists and has resize method
        if (window.map && typeof window.map.resize === 'function') {
            setTimeout(() => window.map!.resize(), 100);
        }

        // Save panel sizes to localStorage
        this.savePanelSizes();
    }

    private getCurrentSizes(config: PanelConfig): PanelSizes {
        const sizes: PanelSizes = {};

        if (config.direction === 'horizontal') {
            if (config.leftPanel && config.rightPanel) {
                const leftRect = config.leftPanel.getBoundingClientRect();
                const rightRect = config.rightPanel.getBoundingClientRect();

                sizes.leftWidth = leftRect.width;
                sizes.rightWidth = rightRect.width;
                sizes.totalWidth = leftRect.width + rightRect.width;
            }
        } else {
            if (config.topPanel && config.bottomPanel) {
                const topRect = config.topPanel.getBoundingClientRect();
                const bottomRect = config.bottomPanel.getBoundingClientRect();

                sizes.topHeight = topRect.height;
                sizes.bottomHeight = bottomRect.height;
                sizes.totalHeight = topRect.height + bottomRect.height;
            }
        }

        return sizes;
    }

    private handleHorizontalResize(e: MouseEvent, config: PanelConfig): void {
        const deltaX = e.clientX - this.startPos.x;

        let newLeftWidth: number;
        let newRightWidth: number;

        const totalWidth = this.startSizes.totalWidth || 0;
        const startLeftWidth = this.startSizes.leftWidth || 0;
        const startRightWidth = this.startSizes.rightWidth || 0;

        if (config.rightPanel?.classList.contains('echo-section')) {
            // Console-echo resizer: moving right decreases echo (right), increases console (left)
            newRightWidth = Math.max(
                config.minRight || 150,
                Math.min(
                    totalWidth - (config.minLeft || 200),
                    startRightWidth - deltaX
                )
            );
            newLeftWidth = totalWidth - newRightWidth;
        } else if (config.rightPanel?.classList.contains('right-panel')) {
            // Map-right resizer: moving right increases right panel, decreases map
            newRightWidth = Math.max(
                config.minRight || 150,
                Math.min(
                    config.maxRight || 400,
                    startRightWidth - deltaX
                )
            );
            newLeftWidth = totalWidth - newRightWidth;
        } else {
            // Left-map resizer: moving right increases left panel
            newLeftWidth = Math.max(
                config.minLeft || 150,
                Math.min(
                    config.maxLeft || 500,
                    startLeftWidth + deltaX
                )
            );
            newRightWidth = totalWidth - newLeftWidth;
        }

        // Apply minimum constraints
        if (config.minRight && newRightWidth < config.minRight) {
            newRightWidth = config.minRight;
            newLeftWidth = totalWidth - newRightWidth;
        }

        if (config.minLeft && newLeftWidth < config.minLeft) {
            newLeftWidth = config.minLeft;
            newRightWidth = totalWidth - newLeftWidth;
        }

        // Update flex basis
        if (config.leftPanel?.classList.contains('console-section')) {
            // Special handling for console sections (use percentages)
            const leftPercent = (newLeftWidth / totalWidth) * 100;
            const rightPercent = (newRightWidth / totalWidth) * 100;

            config.leftPanel.style.flexBasis = `${leftPercent}%`;
            config.rightPanel!.style.flexBasis = `${rightPercent}%`;
        } else {
            // Regular panels (use pixels)
            if (config.leftPanel) {
                config.leftPanel.style.flexBasis = `${newLeftWidth}px`;
            }
            if (config.rightPanel && !config.rightPanel.classList.contains('map-container')) {
                config.rightPanel.style.flexBasis = `${newRightWidth}px`;
            }
        }
    }

    private handleVerticalResize(e: MouseEvent, config: PanelConfig): void {
        const deltaY = e.clientY - this.startPos.y;

        const totalHeight = this.startSizes.totalHeight || 0;
        const startTopHeight = this.startSizes.topHeight || 0;
        const startBottomHeight = this.startSizes.bottomHeight || 0;

        if (config.topPanel?.classList.contains('content-area')) {
            // Main content-console resizer: moving down increases console, decreases content
            const newBottomHeight = Math.max(
                config.minBottom || 120,
                Math.min(
                    config.maxBottom || 400,
                    startBottomHeight - deltaY
                )
            );
            const newTopHeight = totalHeight - newBottomHeight;

            // Apply minimum constraints
            if (config.minTop && newTopHeight < config.minTop) {
                return; // Don't resize if it would violate minimum top height
            }

            // Update flex basis
            if (config.bottomPanel) {
                config.bottomPanel.style.flexBasis = `${newBottomHeight}px`;
            }
        } else {
            // Right panel internal resizers: moving down increases bottom panel, decreases top panel
            const newTopHeight = Math.max(
                config.minTop || 80,
                Math.min(
                    config.maxTop || 400,
                    startTopHeight + deltaY
                )
            );
            const newBottomHeight = totalHeight - newTopHeight;

            // Apply minimum constraints
            if (config.minBottom && newBottomHeight < config.minBottom) {
                return; // Don't resize if it would violate minimum bottom height
            }

            // Update flex basis for both panels
            if (config.topPanel) {
                config.topPanel.style.flexBasis = `${newTopHeight}px`;
            }
            if (
                config.bottomPanel &&
                (!config.bottomPanel.classList.contains('conflicts-panel') ||
                    config.topPanel?.classList.contains('traffic-panel'))
            ) {
                config.bottomPanel.style.flexBasis = `${newBottomHeight}px`;
            }
        }
    }

    /**
     * Public method to reset panels to default sizes
     */
    public resetToDefaults(): void {
        const leftPanel = document.querySelector('.left-panel') as HTMLElement | null;
        const rightPanel = document.querySelector('.right-panel') as HTMLElement | null;
        const consoleContainer = document.querySelector('.console-container') as HTMLElement | null;
        const consoleSection = document.querySelector('.console-section') as HTMLElement | null;
        const echoSection = document.querySelector('.echo-section') as HTMLElement | null;
        const trafficPanel = document.querySelector('.traffic-panel') as HTMLElement | null;
        const aircraftPanel = document.querySelector('.aircraft-panel') as HTMLElement | null;
        const conflictsPanel = document.querySelector('.conflicts-panel') as HTMLElement | null;

        // Reset main panels
        if (leftPanel) leftPanel.style.flexBasis = '250px';
        if (rightPanel) rightPanel.style.flexBasis = '250px';
        if (consoleContainer) consoleContainer.style.flexBasis = '200px';

        // Reset console sections (centered 50/50 split)
        if (consoleSection) consoleSection.style.flexBasis = '50%';
        if (echoSection) echoSection.style.flexBasis = '50%';

        // Reset right panel sections
        if (trafficPanel) trafficPanel.style.flexBasis = '200px';
        if (aircraftPanel) aircraftPanel.style.flexBasis = '150px';
        if (conflictsPanel) conflictsPanel.style.flexBasis = ''; // Let it flex naturally

        // Reset left panel sections
        const nodePanel = document.querySelector('.node-panel') as HTMLElement | null;
        const navPanel = document.querySelector('.nav-panel') as HTMLElement | null;
        const displayPanel = document.querySelector('.display-panel') as HTMLElement | null;

        if (nodePanel) nodePanel.style.flexBasis = '320px';
        if (navPanel) navPanel.style.flexBasis = '160px';
        if (displayPanel) displayPanel.style.flexBasis = ''; // Let it flex naturally

        // Clear saved sizes from localStorage
        this.clearSavedSizes();

        // Trigger map resize if MapLibre instance exists and has resize method
        if (window.map && typeof window.map.resize === 'function') {
            setTimeout(() => window.map!.resize(), 100);
        }
    }

    /**
     * Save current panel sizes to localStorage
     */
    private savePanelSizes(): void {
        try {
            const layoutState: PanelLayoutState = {
                leftPanel: this.getPanelSize('.left-panel'),
                rightPanel: this.getPanelSize('.right-panel'),
                consoleContainer: this.getPanelSize('.console-container'),
                consoleSection: this.getPanelSize('.console-section'),
                echoSection: this.getPanelSize('.echo-section'),
                trafficPanel: this.getPanelSize('.traffic-panel'),
                aircraftPanel: this.getPanelSize('.aircraft-panel'),
                conflictsPanel: this.getPanelSize('.conflicts-panel'),
                nodePanel: this.getPanelSize('.node-panel'),
                navPanel: this.getPanelSize('.nav-panel'),
                displayPanel: this.getPanelSize('.display-panel'),
                timestamp: Date.now(),
                version: PanelResizer.LAYOUT_VERSION
            };

            const success = storage.set(PanelResizer.STORAGE_KEY, layoutState);
            if (success) {
                logger.debug('PanelResizer', 'Panel layout saved to localStorage');
            }
        } catch (error) {
            logger.error('PanelResizer', 'Error saving panel layout:', error);
        }
    }

    /**
     * Load saved panel sizes from localStorage
     */
    private loadPanelSizes(): void {
        try {
            const layoutState = storage.get<PanelLayoutState>(PanelResizer.STORAGE_KEY);

            if (!layoutState) {
                logger.debug('PanelResizer', 'No saved panel layout found');
                return;
            }

            // Check version compatibility
            if (layoutState.version !== PanelResizer.LAYOUT_VERSION) {
                logger.warn('PanelResizer', 'Panel layout version mismatch, clearing saved layout');
                this.clearSavedSizes();
                return;
            }

            // Apply saved sizes to panels
            this.setPanelSize('.left-panel', layoutState.leftPanel);
            this.setPanelSize('.right-panel', layoutState.rightPanel);
            this.setPanelSize('.console-container', layoutState.consoleContainer);
            this.setPanelSize('.console-section', layoutState.consoleSection);
            this.setPanelSize('.echo-section', layoutState.echoSection);
            this.setPanelSize('.traffic-panel', layoutState.trafficPanel);
            this.setPanelSize('.aircraft-panel', layoutState.aircraftPanel);
            this.setPanelSize('.conflicts-panel', layoutState.conflictsPanel);
            this.setPanelSize('.node-panel', layoutState.nodePanel);
            this.setPanelSize('.nav-panel', layoutState.navPanel);
            this.setPanelSize('.display-panel', layoutState.displayPanel);

            logger.debug('PanelResizer', 'Panel layout loaded from localStorage');

            // Trigger map resize after loading (if map exists and has resize method)
            if (window.map && typeof window.map.resize === 'function') {
                setTimeout(() => window.map!.resize(), 100);
            }
        } catch (error) {
            logger.error('PanelResizer', 'Error loading panel layout:', error);
        }
    }

    /**
     * Clear saved panel sizes from localStorage
     */
    private clearSavedSizes(): void {
        try {
            storage.remove(PanelResizer.STORAGE_KEY);
            logger.debug('PanelResizer', 'Saved panel layout cleared from localStorage');
        } catch (error) {
            logger.error('PanelResizer', 'Error clearing saved panel layout:', error);
        }
    }

    /**
     * Get the current size of a panel element
     */
    private getPanelSize(selector: string): string {
        const panel = document.querySelector(selector) as HTMLElement | null;
        if (!panel) {
            return '';
        }
        return panel.style.flexBasis || '';
    }

    /**
     * Set the size of a panel element
     */
    private setPanelSize(selector: string, size: string): void {
        const panel = document.querySelector(selector) as HTMLElement | null;
        if (!panel || !size) {
            return;
        }
        panel.style.flexBasis = size;
    }

    /**
     * Clean up event listeners
     */
    public destroy(): void {
        if (this.handles) {
            this.handles.forEach(handle => {
                // Note: We can't remove the bound event listeners without storing references
                // This is a limitation we'll accept for now
            });
        }

        document.removeEventListener('mousemove', this.onMouseMove.bind(this));
        document.removeEventListener('mouseup', this.onMouseUp.bind(this));
    }
}

/**
 * Export singleton instance for global access
 */
export const panelResizer = new PanelResizer();

/**
 * Make panel resizer available globally for debugging and external access
 */
if (typeof window !== 'undefined') {
    window.panelResizer = panelResizer;
}
