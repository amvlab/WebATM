import { logger } from '../utils/Logger';
import { onDOMReady, escapeHtml } from '../utils/dom';

/**
 * Console Management System
 * Handles console messages, command input, and console UI updates
 */
export class ConsoleManager {
    private consoleLog: HTMLElement | null = null;
    private consoleInput: HTMLInputElement | null = null;
    private maxMessages = 100;
    private isInitialized = false;

    constructor() {
        this.init();
    }

    private init(): void {
        if (this.isInitialized) return;
        onDOMReady(() => this.initializeElements());
    }

    private initializeElements(): void {
        this.consoleLog = document.getElementById('console-output');
        this.consoleInput = document.getElementById('console-input') as HTMLInputElement;

        if (!this.consoleLog) {
            logger.warn('ConsoleManager', 'Console output element not found - console messages will only appear in browser console');
        }

        if (!this.consoleInput) {
            logger.warn('ConsoleManager', 'Console input element not found - command input will not be available');
        }

        this.setupEventListeners();
        this.isInitialized = true;
    }

    private setupEventListeners(): void {
        // NOTE: Command input handling is now done by Console.ts
        // ConsoleManager only handles message display (info, error, warning, success)
        // Removing keypress listener to avoid conflicts with Console.ts history management

        // Listen for global console events
        document.addEventListener('consoleMessage', (e) => {
            const { message, type } = e.detail;
            this.addMessage(message, type);
        });
    }

    /**
     * Add a message to the console
     */
    public addMessage(message: string, type: string = 'info'): void {
        // Always log using the logger system for consistency
        switch (type) {
            case 'error':
                logger.error('ConsoleManager', message);
                break;
            case 'warning':
                logger.warn('ConsoleManager', message);
                break;
            default:
                logger.info('ConsoleManager', message);
                break;
        }

        // Add to UI console if available
        if (this.consoleLog) {
            const messageElement = document.createElement('div');
            messageElement.className = `console-message console-${type}`;
            
            const timestamp = new Date().toLocaleTimeString();
            messageElement.innerHTML = `
                <span class="console-timestamp">${timestamp}</span>
                <span class="console-text">${escapeHtml(message)}</span>
            `;
            
            this.consoleLog.appendChild(messageElement);
            
            // Auto-scroll to bottom
            this.consoleLog.scrollTop = this.consoleLog.scrollHeight;
            
            // Limit console messages to prevent memory issues
            this.limitMessages();
        }

        // Emit event for other components to listen
        const event = new CustomEvent('consoleMessageAdded', {
            detail: { message, type, timestamp: new Date() }
        });
        document.dispatchEvent(event);
    }

    /**
     * Add info message
     */
    public info(message: string): void {
        this.addMessage(message, 'info');
    }

    /**
     * Add warning message
     */
    public warning(message: string): void {
        this.addMessage(message, 'warning');
    }

    /**
     * Add error message
     */
    public error(message: string): void {
        this.addMessage(message, 'error');
    }

    /**
     * Add success message
     */
    public success(message: string): void {
        this.addMessage(message, 'success');
    }

    /**
     * Clear all console messages
     */
    public clear(): void {
        if (this.consoleLog) {
            this.consoleLog.innerHTML = '';
        }
        
        const event = new CustomEvent('consoleCleared');
        document.dispatchEvent(event);
    }

    /**
     * Limit console messages to prevent memory issues
     */
    private limitMessages(): void {
        if (!this.consoleLog) return;

        const messages = this.consoleLog.children;
        while (messages.length > this.maxMessages) {
            this.consoleLog.removeChild(messages[0]);
        }
    }

    /**
     * Focus console input
     */
    public focusInput(): void {
        if (this.consoleInput) {
            this.consoleInput.focus();
        }
    }

    /**
     * Set max messages limit
     */
    public setMaxMessages(limit: number): void {
        this.maxMessages = Math.max(10, limit);
    }

    /**
     * Get console element for external manipulation
     */
    public getConsoleElement(): HTMLElement | null {
        return this.consoleLog;
    }

    /**
     * Get input element for external manipulation
     */
    public getInputElement(): HTMLInputElement | null {
        return this.consoleInput;
    }

    /**
     * Check if console is initialized
     */
    public isReady(): boolean {
        return this.isInitialized;
    }
}

// Export singleton instance
export const consoleManager = new ConsoleManager();