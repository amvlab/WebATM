/**
 * Tests for the Logger. Deliberately runs in the node environment (no
 * localStorage): importing the module used to throw there because the
 * singleton read localStorage unguarded at import time.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { logger, LogLevel } from './Logger';

afterEach(() => {
    logger.resetConfig();
    vi.restoreAllMocks();
});

describe('Logger', () => {
    it('imports and works without localStorage (node environment)', () => {
        expect(logger.getLevel()).toBe(LogLevel.INFO);
    });

    it('setLevel/getLevel/getLevelName round-trip', () => {
        logger.setLevel(LogLevel.DEBUG);
        expect(logger.getLevel()).toBe(LogLevel.DEBUG);
        expect(logger.getLevelName()).toBe('DEBUG');
        expect(logger.getLevelName(LogLevel.VERBOSE)).toBe('VERBOSE');
    });

    it('suppresses messages above the configured level', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        logger.setLevel(LogLevel.ERROR);
        logger.info('Test', 'hidden');
        logger.debug('Test', 'hidden');
        logger.error('Test', 'shown');

        expect(log).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledTimes(1);
    });

    it('emits messages at or below the configured level with component prefix', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        logger.setLevel(LogLevel.VERBOSE);
        logger.verbose('SocketManager', 'details');

        expect(log).toHaveBeenCalledWith('[SocketManager] details');
    });

    it('resetConfig restores defaults', () => {
        logger.setLevel(LogLevel.VERBOSE);
        logger.setTimestamps(true);
        logger.resetConfig();
        expect(logger.getConfig()).toEqual({
            level: LogLevel.INFO,
            enableTimestamps: false,
            enableComponentPrefixes: true,
        });
    });

    it('getLevelName reports UNKNOWN for out-of-range levels', () => {
        expect(logger.getLevelName(99 as LogLevel)).toBe('UNKNOWN');
    });
});

/**
 * Startup log-level resolution. The singleton reads WEBATM_LOG_LEVEL /
 * ?log_level= once at import time, so each case re-imports a fresh module
 * (and stubs `window` where a URL parameter is involved).
 */
describe('startup log-level resolution', () => {
    afterEach(() => {
        delete process.env.WEBATM_LOG_LEVEL;
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    async function freshLogger(urlSearch?: string) {
        if (urlSearch !== undefined) {
            vi.stubGlobal('window', { location: { search: urlSearch } });
        }
        vi.resetModules();
        return import('./Logger');
    }

    it('reads a valid WEBATM_LOG_LEVEL env var', async () => {
        process.env.WEBATM_LOG_LEVEL = 'debug';
        const fresh = await freshLogger();
        expect(fresh.logger.getLevel()).toBe(fresh.LogLevel.DEBUG);
    });

    it('accepts numeric levels and the TRACE/WARNING aliases', async () => {
        process.env.WEBATM_LOG_LEVEL = '4';
        expect((await freshLogger()).logger.getLevel()).toBe(LogLevel.VERBOSE);
        process.env.WEBATM_LOG_LEVEL = 'TRACE';
        expect((await freshLogger()).logger.getLevel()).toBe(LogLevel.VERBOSE);
        process.env.WEBATM_LOG_LEVEL = 'warning';
        expect((await freshLogger()).logger.getLevel()).toBe(LogLevel.WARN);
    });

    it('falls back to the default for unparseable values', async () => {
        for (const bogus of ['bogus', '42', '3abc', '-1']) {
            process.env.WEBATM_LOG_LEVEL = bogus;
            expect((await freshLogger()).logger.getLevel()).toBe(LogLevel.INFO);
        }
    });

    it('does not let parseInt turn "0x1" into ERROR (URL parameter)', async () => {
        const fresh = await freshLogger('?log_level=0x1');
        expect(fresh.logger.getLevel()).toBe(fresh.LogLevel.INFO);
    });

    it('reads a valid ?log_level= URL parameter', async () => {
        const fresh = await freshLogger('?log_level=verbose');
        expect(fresh.logger.getLevel()).toBe(fresh.LogLevel.VERBOSE);
    });

    it('an invalid env var does not mask a valid URL parameter', async () => {
        process.env.WEBATM_LOG_LEVEL = 'bogus';
        const fresh = await freshLogger('?log_level=error');
        expect(fresh.logger.getLevel()).toBe(fresh.LogLevel.ERROR);
    });

    it('a valid env var takes precedence over the URL parameter', async () => {
        process.env.WEBATM_LOG_LEVEL = 'debug';
        const fresh = await freshLogger('?log_level=error');
        expect(fresh.logger.getLevel()).toBe(fresh.LogLevel.DEBUG);
    });
});
