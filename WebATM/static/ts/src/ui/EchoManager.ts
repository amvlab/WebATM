import { logger } from '../utils/Logger';

/**
 * Echo Management System
 * Handles echo messages for system notifications and status updates
 */
export class EchoManager {
    private echoOutput: HTMLElement | null = null;
    private maxMessages = 100;
    private isInitialized = false;

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
        this.echoOutput = document.getElementById('echo-output');

        if (!this.echoOutput) {
            logger.warn('EchoManager', 'Echo output element not found - echo messages will only appear in browser console');
        }

        this.setupEventListeners();
        this.isInitialized = true;
    }

    private setupEventListeners(): void {
        // Listen for clear echo button
        const clearButton = document.getElementById('clear-echo');
        if (clearButton) {
            clearButton.addEventListener('click', () => this.clear());
        }

        // Listen for global echo events
        document.addEventListener('echoMessage', (e: any) => {
            const { message, type } = e.detail;
            this.addMessage(message, type);
        });
    }

    /**
     * Add a message to the echo output
     * @param message The message text to display
     * @param type The message type (info, error, warning, success)
     * @param nodeId Optional node ID to display instead of timestamp (for BlueSky command responses)
     */
    public addMessage(message: string, type: string = 'info', nodeId?: string): void {
        // Always log to browser console for debugging using logger
        switch (type) {
            case 'error':
                logger.error('EchoManager', message);
                break;
            case 'warning':
                logger.warn('EchoManager', message);
                break;
            default:
                logger.info('EchoManager', message);
                break;
        }

        // Add to UI echo output if available
        if (this.echoOutput) {
            const messageElement = document.createElement('div');
            messageElement.className = `echo-line echo-${type}`;

            // For success, warning, and error messages, always show timestamp
            // For BlueSky responses (info), show node ID if available, otherwise nothing
            let prefix = '';
            if (type === 'success' || type === 'warning' || type === 'error') {
                const timestamp = new Date().toLocaleTimeString();
                prefix = `<span class="echo-timestamp">${timestamp}</span>`;
            } else if (nodeId) {
                prefix = `<span class="echo-node-id">${this.escapeHtml(nodeId)}</span>`;
            }

            messageElement.innerHTML = `
                ${prefix}
                <span class="echo-text">${this.escapeHtml(message)}</span>
            `;

            this.echoOutput.appendChild(messageElement);

            // Auto-scroll to bottom
            this.echoOutput.scrollTop = this.echoOutput.scrollHeight;

            // Limit echo messages to prevent memory issues
            this.limitMessages();
        }

        // Emit event for other components to listen
        const event = new CustomEvent('echoMessageAdded', {
            detail: { message, type, nodeId, timestamp: new Date() }
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
     * Clear all echo messages
     */
    public clear(): void {
        if (this.echoOutput) {
            this.echoOutput.innerHTML = '';
        }

        const event = new CustomEvent('echoCleared');
        document.dispatchEvent(event);
    }

    /**
     * Limit echo messages to prevent memory issues
     */
    private limitMessages(): void {
        if (!this.echoOutput) return;

        const messages = this.echoOutput.children;
        while (messages.length > this.maxMessages) {
            this.echoOutput.removeChild(messages[0]);
        }
    }

    /**
     * Escape HTML to prevent XSS
     */
    private escapeHtml(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Set max messages limit
     */
    public setMaxMessages(limit: number): void {
        this.maxMessages = Math.max(10, limit);
    }

    /**
     * Get echo element for external manipulation
     */
    public getEchoElement(): HTMLElement | null {
        return this.echoOutput;
    }

    /**
     * Check if echo manager is initialized
     */
    public isReady(): boolean {
        return this.isInitialized;
    }
}

// Export singleton instance
export const echoManager = new EchoManager();
