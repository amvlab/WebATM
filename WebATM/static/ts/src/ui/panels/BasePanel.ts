import { logger } from '../../utils/Logger';

/**
 * BasePanel - Abstract base class for all UI panels
 * Provides common functionality for panel management including:
 * - DOM element management
 * - Event listener cleanup
 * - Lifecycle methods
 * - Common panel operations (collapse/expand)
 */

export abstract class BasePanel {
    protected panelElement: HTMLElement | null = null;
    protected panelContent: HTMLElement | null = null;
    protected collapseButton: HTMLElement | null = null;
    protected eventListeners: Array<{
        element: HTMLElement;
        event: string;
        handler: EventListener;
    }> = [];

    /**
     * @param panelSelector - CSS selector for the panel container
     * @param contentId - ID of the panel content element (optional)
     */
    constructor(
        protected panelSelector: string,
        protected contentId?: string
    ) {}

    /**
     * Initialize the panel
     * Must be called after DOM is ready
     */
    public init(): void {
        this.panelElement = document.querySelector(this.panelSelector);

        if (!this.panelElement) {
            logger.warn('BasePanel', `Panel element not found: ${this.panelSelector}`);
            return;
        }

        if (this.contentId) {
            this.panelContent = document.getElementById(this.contentId);
        }

        // Find collapse button
        this.collapseButton = this.panelElement.querySelector('.collapse-btn');
        if (this.collapseButton) {
            this.setupCollapseButton();
        }

        // Call subclass initialization
        this.onInit();
    }

    /**
     * Subclasses override this to perform custom initialization
     */
    protected abstract onInit(): void;

    /**
     * Set up collapse/expand functionality
     */
    private setupCollapseButton(): void {
        if (!this.collapseButton || !this.panelContent) return;

        const handler = () => this.toggleCollapse();
        this.addEventListener(this.collapseButton, 'click', handler);
    }

    /**
     * Toggle panel collapse state
     */
    protected toggleCollapse(): void {
        if (!this.panelContent || !this.collapseButton) return;

        const isCollapsed = this.panelContent.style.display === 'none';

        if (isCollapsed) {
            this.panelContent.style.display = '';
            this.collapseButton.textContent = '▼';
        } else {
            this.panelContent.style.display = 'none';
            this.collapseButton.textContent = '▶';
        }
    }

    /**
     * Add an event listener and track it for cleanup
     */
    protected addEventListener(
        element: HTMLElement,
        event: string,
        handler: EventListener
    ): void {
        element.addEventListener(event, handler);
        this.eventListeners.push({ element, event, handler });
    }

    /**
     * Get an element within the panel
     */
    protected getElement(selector: string): HTMLElement | null {
        if (!this.panelElement) return null;
        return this.panelElement.querySelector(selector);
    }

    /**
     * Get an element by ID within the panel
     */
    protected getElementById(id: string): HTMLElement | null {
        return document.getElementById(id);
    }

    /**
     * Update panel content (override in subclasses)
     */
    public abstract update(data?: any): void;

    /**
     * Clean up panel resources
     */
    public destroy(): void {
        // Remove all event listeners
        this.eventListeners.forEach(({ element, event, handler }) => {
            element.removeEventListener(event, handler);
        });
        this.eventListeners = [];

        // Call subclass cleanup
        this.onDestroy();
    }

    /**
     * Subclasses override this to perform custom cleanup
     */
    protected onDestroy(): void {
        // Default: no additional cleanup
    }

    /**
     * Show the panel
     */
    public show(): void {
        if (this.panelElement) {
            this.panelElement.style.display = '';
        }
    }

    /**
     * Hide the panel
     */
    public hide(): void {
        if (this.panelElement) {
            this.panelElement.style.display = 'none';
        }
    }

    /**
     * Check if panel is visible
     */
    public isVisible(): boolean {
        if (!this.panelElement) return false;
        return this.panelElement.style.display !== 'none';
    }
}
