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
});
