/**
 * Logger utility for WebATM TypeScript application
 *
 * Provides configurable logging levels to reduce console clutter while
 * maintaining debugging capabilities. The level is resolved at startup from
 * the `WEBATM_LOG_LEVEL` environment variable, the `?log_level=` URL
 * parameter, or localStorage, in that order.
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

const DEFAULT_CONFIG: LoggerConfig = {
    level: LogLevel.INFO,
    enableTimestamps: false,
    enableComponentPrefixes: true
};

class Logger {
    private config: LoggerConfig = { ...DEFAULT_CONFIG };

    constructor() {
        this.loadConfiguration();
    }

    /**
     * Safe localStorage accessors. The logger can't use StorageManager
     * (StorageManager logs through this class, which would be a circular
     * import), so it guards its own access: localStorage may be missing
     * (Node, tests) or throw (privacy mode, quota).
     */
    private storageGet(key: string): string | null {
        try {
            return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
        } catch {
            return null;
        }
    }

    private storageSet(key: string, value: string): void {
        try {
            if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
        } catch {
            // Persisting logger settings is best-effort
        }
    }

    private storageRemove(key: string): void {
        try {
            if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
        } catch {
            // Best-effort
        }
    }

    private loadConfiguration(): void {
        const override = this.getEnvironmentLogLevel();
        if (override !== null) {
            this.config.level = override;
        } else {
            const savedLevel = this.storageGet('webatm-log-level');
            const level = savedLevel !== null ? this.parseLogLevel(savedLevel) : null;
            if (level !== null) {
                this.config.level = level;
            }
        }

        const savedTimestamps = this.storageGet('webatm-log-timestamps');
        if (savedTimestamps !== null) {
            this.config.enableTimestamps = savedTimestamps === 'true';
        }

        const savedPrefixes = this.storageGet('webatm-log-prefixes');
        if (savedPrefixes !== null) {
            this.config.enableComponentPrefixes = savedPrefixes === 'true';
        }
    }

    /**
     * Log-level override from the environment: the `WEBATM_LOG_LEVEL`
     * environment variable (Node contexts), then the `?log_level=` URL
     * parameter (browser debugging). An unparseable value in one source
     * falls through to the next rather than masking it.
     */
    private getEnvironmentLogLevel(): LogLevel | null {
        if (typeof process !== 'undefined' && process.env?.WEBATM_LOG_LEVEL) {
            const level = this.parseLogLevel(process.env.WEBATM_LOG_LEVEL);
            if (level !== null) {
                return level;
            }
        }

        if (typeof window !== 'undefined') {
            const urlLevel = new URLSearchParams(window.location.search).get('log_level');
            if (urlLevel) {
                return this.parseLogLevel(urlLevel);
            }
        }

        return null;
    }

    /**
     * Parse a level name ("debug", "WARNING") or numeric level ("0"-"4").
     * Returns null for anything else — malformed input must never select a
     * level by accident (e.g. parseInt would turn "0x1" into ERROR).
     */
    private parseLogLevel(levelStr: string): LogLevel | null {
        const normalized = levelStr.trim().toUpperCase();
        switch (normalized) {
            case 'ERROR': return LogLevel.ERROR;
            case 'WARN': case 'WARNING': return LogLevel.WARN;
            case 'INFO': return LogLevel.INFO;
            case 'DEBUG': return LogLevel.DEBUG;
            case 'VERBOSE': case 'TRACE': return LogLevel.VERBOSE;
            default:
                return /^[0-4]$/.test(normalized) ? (Number(normalized) as LogLevel) : null;
        }
    }

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

        return formatted + message;
    }

    private emit(level: LogLevel, consoleFn: 'error' | 'warn' | 'log',
        component: string, message: string, args: unknown[]): void {
        if (level <= this.config.level) {
            console[consoleFn](this.formatMessage(component, message), ...args);
        }
    }

    /** Log error message (always shown) */
    error(component: string, message: string, ...args: unknown[]): void {
        this.emit(LogLevel.ERROR, 'error', component, message, args);
    }

    /** Log warning message */
    warn(component: string, message: string, ...args: unknown[]): void {
        this.emit(LogLevel.WARN, 'warn', component, message, args);
    }

    /** Log info message (normal operation) */
    info(component: string, message: string, ...args: unknown[]): void {
        this.emit(LogLevel.INFO, 'log', component, message, args);
    }

    /** Log debug message (detailed information) */
    debug(component: string, message: string, ...args: unknown[]): void {
        this.emit(LogLevel.DEBUG, 'log', component, message, args);
    }

    /** Log verbose message (very detailed information) */
    verbose(component: string, message: string, ...args: unknown[]): void {
        this.emit(LogLevel.VERBOSE, 'log', component, message, args);
    }

    getLevel(): LogLevel {
        return this.config.level;
    }

    /** Set log level and persist it to localStorage */
    setLevel(level: LogLevel): void {
        this.config.level = level;
        this.storageSet('webatm-log-level', level.toString());
    }

    /** Name of the given level (defaults to the current one) */
    getLevelName(level?: LogLevel): string {
        return LogLevel[level ?? this.config.level] ?? 'UNKNOWN';
    }

    setTimestamps(enabled: boolean): void {
        this.config.enableTimestamps = enabled;
        this.storageSet('webatm-log-timestamps', enabled.toString());
    }

    setComponentPrefixes(enabled: boolean): void {
        this.config.enableComponentPrefixes = enabled;
        this.storageSet('webatm-log-prefixes', enabled.toString());
    }

    getConfig(): Readonly<LoggerConfig> {
        return { ...this.config };
    }

    /** Reset configuration to defaults and clear persisted settings */
    resetConfig(): void {
        this.config = { ...DEFAULT_CONFIG };
        this.storageRemove('webatm-log-level');
        this.storageRemove('webatm-log-timestamps');
        this.storageRemove('webatm-log-prefixes');
    }
}

export const logger = new Logger();
