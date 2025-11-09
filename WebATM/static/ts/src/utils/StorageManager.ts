/**
 * Storage Manager Utility
 * Provides type-safe localStorage wrapper with error handling
 */

import { logger } from './Logger';

export class StorageManager {
    private namespace: string;

    constructor(namespace: string = 'webatm') {
        this.namespace = namespace;
    }

    /**
     * Get a namespaced key
     */
    private getKey(key: string): string {
        return `${this.namespace}-${key}`;
    }

    /**
     * Check if localStorage is available
     */
    private isAvailable(): boolean {
        try {
            const test = '__storage_test__';
            localStorage.setItem(test, test);
            localStorage.removeItem(test);
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Get a value from localStorage with type safety
     */
    public get<T>(key: string, defaultValue?: T): T | null {
        if (!this.isAvailable()) {
            logger.warn('StorageManager', 'localStorage is not available');
            return defaultValue ?? null;
        }

        try {
            const item = localStorage.getItem(this.getKey(key));
            if (item === null) {
                return defaultValue ?? null;
            }
            return JSON.parse(item) as T;
        } catch (error) {
            logger.error('StorageManager', `Error reading from localStorage (key: ${key}):`, error);
            return defaultValue ?? null;
        }
    }

    /**
     * Set a value in localStorage
     */
    public set<T>(key: string, value: T): boolean {
        if (!this.isAvailable()) {
            logger.warn('StorageManager', 'localStorage is not available');
            return false;
        }

        try {
            const serialized = JSON.stringify(value);
            localStorage.setItem(this.getKey(key), serialized);
            return true;
        } catch (error) {
            if (error instanceof DOMException && error.name === 'QuotaExceededError') {
                logger.error('StorageManager', 'localStorage quota exceeded');
            } else {
                logger.error('StorageManager', `Error writing to localStorage (key: ${key}):`, error);
            }
            return false;
        }
    }

    /**
     * Remove a value from localStorage
     */
    public remove(key: string): void {
        if (!this.isAvailable()) {
            logger.warn('StorageManager', 'localStorage is not available');
            return;
        }

        try {
            localStorage.removeItem(this.getKey(key));
        } catch (error) {
            logger.error('StorageManager', `Error removing from localStorage (key: ${key}):`, error);
        }
    }

    /**
     * Clear all items with this namespace
     */
    public clearNamespace(): void {
        if (!this.isAvailable()) {
            logger.warn('StorageManager', 'localStorage is not available');
            return;
        }

        try {
            const keys = Object.keys(localStorage);
            const prefix = `${this.namespace}-`;

            keys.forEach(key => {
                if (key.startsWith(prefix)) {
                    localStorage.removeItem(key);
                }
            });
        } catch (error) {
            logger.error('StorageManager', 'Error clearing namespace from localStorage:', error);
        }
    }

    /**
     * Check if a key exists
     */
    public has(key: string): boolean {
        if (!this.isAvailable()) {
            return false;
        }

        try {
            return localStorage.getItem(this.getKey(key)) !== null;
        } catch (error) {
            logger.error('StorageManager', `Error checking localStorage (key: ${key}):`, error);
            return false;
        }
    }

    /**
     * Get all keys with this namespace
     */
    public getKeys(): string[] {
        if (!this.isAvailable()) {
            return [];
        }

        try {
            const keys = Object.keys(localStorage);
            const prefix = `${this.namespace}-`;

            return keys
                .filter(key => key.startsWith(prefix))
                .map(key => key.substring(prefix.length));
        } catch (error) {
            logger.error('StorageManager', 'Error getting keys from localStorage:', error);
            return [];
        }
    }
}

/**
 * Export singleton instance for global use
 */
export const storage = new StorageManager('webatm');
