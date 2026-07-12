import { logger } from '../../utils/Logger';
import { ListenerRegistry } from '../../utils/events';

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
    protected listeners = new ListenerRegistry();
    private subscriptions: Array<() => void> = [];

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

        const collapsed = !this.panelContent.classList.contains('collapsed');

        // CSS shrinks the panel to its header bar and rotates the chevron
        this.panelContent.classList.toggle('collapsed', collapsed);
        this.collapseButton.classList.toggle('collapsed', collapsed);
        this.panelElement?.classList.toggle('collapsed', collapsed);
    }

    /**
     * Add an event listener and track it for cleanup
     */
    protected addEventListener(
        element: HTMLElement,
        event: string,
        handler: EventListener
    ): void {
        this.listeners.add(element, event, handler);
    }

    /**
     * Attach a tracked event listener to an element by ID, with the
     * standard warn-if-missing handling that panels used to copy-paste.
     * Returns the element so callers can chain further setup.
     */
    protected bindEvent(
        id: string,
        event: string,
        handler: EventListener
    ): HTMLElement | null {
        const element = document.getElementById(id);
        if (!element) {
            logger.warn(this.constructor.name, `Element not found: ${id}`);
            return null;
        }
        this.addEventListener(element, event, handler);
        return element;
    }

    /**
     * Attach a tracked click handler to an element by ID.
     */
    protected bindClick(id: string, handler: () => void): HTMLElement | null {
        return this.bindEvent(id, 'click', () => handler());
    }

    /**
     * Attach a tracked 'input' handler that receives the input's value.
     */
    protected bindInput(id: string, handler: (value: string) => void): HTMLElement | null {
        return this.bindEvent(id, 'input', (e) => {
            handler((e.target as HTMLInputElement).value);
        });
    }

    /**
     * Attach a tracked 'change' handler that receives the select/input value.
     */
    protected bindChange(id: string, handler: (value: string) => void): HTMLElement | null {
        return this.bindEvent(id, 'change', (e) => {
            handler((e.target as HTMLInputElement | HTMLSelectElement).value);
        });
    }

    /**
     * Attach a tracked 'change' handler to a checkbox that receives its
     * checked state.
     */
    protected bindCheckbox(id: string, handler: (checked: boolean) => void): HTMLElement | null {
        return this.bindEvent(id, 'change', (e) => {
            handler((e.target as HTMLInputElement).checked);
        });
    }

    /**
     * Set an input/select value by element ID, ignoring missing elements.
     */
    protected setInputValue(id: string, value: string | number): void {
        const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
        if (element) element.value = String(value);
    }

    /**
     * Set a checkbox's checked state by element ID, ignoring missing elements.
     */
    protected setChecked(id: string, checked: boolean): void {
        const element = document.getElementById(id) as HTMLInputElement | null;
        if (element) element.checked = checked;
    }

    /**
     * Set an element's text content by element ID, ignoring missing elements.
     */
    protected setText(id: string, text: string): void {
        const element = document.getElementById(id);
        if (element) element.textContent = text;
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
     * Track an unsubscribe function (e.g. from StateManager.subscribe) so
     * the subscription is released in destroy(). Without this, destroyed
     * panels keep reacting to state changes on detached DOM.
     */
    protected trackSubscription(unsubscribe: () => void): void {
        this.subscriptions.push(unsubscribe);
    }

    /**
     * Update panel content (override in subclasses)
     */
    public abstract update(data?: unknown): void;

    /**
     * Clean up panel resources
     */
    public destroy(): void {
        this.listeners.removeAll();
        this.subscriptions.forEach(unsubscribe => unsubscribe());
        this.subscriptions = [];
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
