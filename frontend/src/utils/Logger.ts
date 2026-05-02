/**
 * Logger utility for WebATM TypeScript application
 * 
 * Provides configurable logging levels to reduce console clutter while maintaining
 * debugging capabilities. Supports environment-based and runtime configuration.
 */

export enum LogLevel {
    ERROR = 0,
    WARN = 1,
    INFO = 2,
    DEBUG = 3,
    VERBOSE = 4
}

export interface LoggerConfig {
    level: LogLevel;
    enableTimestamps: boolean;
    enableComponentPrefixes: boolean;
}

class Logger {
    private config: LoggerConfig = {
        level: LogLevel.INFO, // Default to INFO level
        enableTimestamps: false,
        enableComponentPrefixes: true
    };

    constructor() {
        this.loadConfiguration();
    }

    /**
     * Load configuration from environment variables and localStorage
     */
    private loadConfiguration(): void {
        // Check environment variable first
        const envLogLevel = this.getEnvironmentLogLevel();
        if (envLogLevel !== null) {
            this.config.level = envLogLevel;
        } else {
            // Fallback to localStorage
            const savedLevel = localStorage.getItem('webatm-log-level');
            if (savedLevel !== null) {
                const level = parseInt(savedLevel, 10);
                if (level >= LogLevel.ERROR && level <= LogLevel.VERBOSE) {
                    this.config.level = level;
                }
            }
        }

        // Load other settings from localStorage
        const savedTimestamps = localStorage.getItem('webatm-log-timestamps');
        if (savedTimestamps !== null) {
            this.config.enableTimestamps = savedTimestamps === 'true';
        }

        const savedPrefixes = localStorage.getItem('webatm-log-prefixes');
        if (savedPrefixes !== null) {
            this.config.enableComponentPrefixes = savedPrefixes === 'true';
        }
    }

    /**
     * Get log level from environment variables
     */
    private getEnvironmentLogLevel(): LogLevel | null {
        // Check for environment variable (works in both browser and Node.js contexts)
        if (typeof process !== 'undefined' && process.env) {
            const envLevel = process.env.WEBATM_LOG_LEVEL;
            if (envLevel) {
                return this.parseLogLevel(envLevel);
            }
        }

        // Check for URL parameter (useful for browser debugging)
        if (typeof window !== 'undefined') {
            const urlParams = new URLSearchParams(window.location.search);
            const urlLevel = urlParams.get('log_level');
            if (urlLevel) {
                return this.parseLogLevel(urlLevel);
            }
        }

        return null;
    }

    /**
     * Parse log level from string
     */
    private parseLogLevel(levelStr: string): LogLevel | null {
        const normalizedLevel = levelStr.toUpperCase();
        switch (normalizedLevel) {
            case 'ERROR': return LogLevel.ERROR;
            case 'WARN': case 'WARNING': return LogLevel.WARN;
            case 'INFO': return LogLevel.INFO;
            case 'DEBUG': return LogLevel.DEBUG;
            case 'VERBOSE': case 'TRACE': return LogLevel.VERBOSE;
            default:
                const numLevel = parseInt(levelStr, 10);
                if (numLevel >= LogLevel.ERROR && numLevel <= LogLevel.VERBOSE) {
                    return numLevel;
                }
                return null;
        }
    }

    /**
     * Format log message with timestamp and component prefix
     */
    private formatMessage(component: string, message: string): string {
        let formatted = '';

        if (this.config.enableTimestamps) {
            const now = new Date();
            const timestamp = now.toLocaleTimeString('en-US', { 
                hour12: false, 
                hour: '2-digit', 
                minute: '2-digit', 
                second: '2-digit'
            });
            const ms = now.getMilliseconds().toString().padStart(3, '0');
            formatted += `${timestamp}.${ms} `;
        }

        if (this.config.enableComponentPrefixes && component) {
            formatted += `[${component}] `;
        }

        formatted += message;
        return formatted;
    }

    /**
     * Check if a log level should be output
     */
    private shouldLog(level: LogLevel): boolean {
        return level <= this.config.level;
    }

    /**
     * Log error message (always shown)
     */
    error(component: string, message: string, ...args: any[]): void {
        if (this.shouldLog(LogLevel.ERROR)) {
            console.error(this.formatMessage(component, message), ...args);
        }
    }

    /**
     * Log warning message
     */
    warn(component: string, message: string, ...args: any[]): void {
        if (this.shouldLog(LogLevel.WARN)) {
            console.warn(this.formatMessage(component, message), ...args);
        }
    }

    /**
     * Log info message (normal operation)
     */
    info(component: string, message: string, ...args: any[]): void {
        if (this.shouldLog(LogLevel.INFO)) {
            console.log(this.formatMessage(component, message), ...args);
        }
    }

    /**
     * Log debug message (detailed information)
     */
    debug(component: string, message: string, ...args: any[]): void {
        if (this.shouldLog(LogLevel.DEBUG)) {
            console.log(this.formatMessage(component, message), ...args);
        }
    }

    /**
     * Log verbose message (very detailed information)
     */
    verbose(component: string, message: string, ...args: any[]): void {
        if (this.shouldLog(LogLevel.VERBOSE)) {
            console.log(this.formatMessage(component, message), ...args);
        }
    }

    /**
     * Get current log level
     */
    getLevel(): LogLevel {
        return this.config.level;
    }

    /**
     * Set log level and persist to localStorage
     */
    setLevel(level: LogLevel): void {
        this.config.level = level;
        localStorage.setItem('webatm-log-level', level.toString());
    }

    /**
     * Get level name as string
     */
    getLevelName(level?: LogLevel): string {
        const targetLevel = level ?? this.config.level;
        switch (targetLevel) {
            case LogLevel.ERROR: return 'ERROR';
            case LogLevel.WARN: return 'WARN';
            case LogLevel.INFO: return 'INFO';
            case LogLevel.DEBUG: return 'DEBUG';
            case LogLevel.VERBOSE: return 'VERBOSE';
            default: return 'UNKNOWN';
        }
    }

    /**
     * Enable/disable timestamps
     */
    setTimestamps(enabled: boolean): void {
        this.config.enableTimestamps = enabled;
        localStorage.setItem('webatm-log-timestamps', enabled.toString());
    }

    /**
     * Enable/disable component prefixes
     */
    setComponentPrefixes(enabled: boolean): void {
        this.config.enableComponentPrefixes = enabled;
        localStorage.setItem('webatm-log-prefixes', enabled.toString());
    }

    /**
     * Get current configuration
     */
    getConfig(): Readonly<LoggerConfig> {
        return { ...this.config };
    }

    /**
     * Reset configuration to defaults
     */
    resetConfig(): void {
        this.config = {
            level: LogLevel.INFO,
            enableTimestamps: false,
            enableComponentPrefixes: true
        };
        localStorage.removeItem('webatm-log-level');
        localStorage.removeItem('webatm-log-timestamps');
        localStorage.removeItem('webatm-log-prefixes');
    }
}

// Export singleton instance
export const logger = new Logger();

// Export convenience methods for common usage patterns
export const log = {
    error: (component: string, message: string, ...args: any[]) => logger.error(component, message, ...args),
    warn: (component: string, message: string, ...args: any[]) => logger.warn(component, message, ...args),
    info: (component: string, message: string, ...args: any[]) => logger.info(component, message, ...args),
    debug: (component: string, message: string, ...args: any[]) => logger.debug(component, message, ...args),
    verbose: (component: string, message: string, ...args: any[]) => logger.verbose(component, message, ...args)
};

export default logger;