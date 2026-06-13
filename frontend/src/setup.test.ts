/**
 * Smoke test for the Vitest setup: verifies that TypeScript modules from
 * src/ resolve and run under the test toolchain.
 */
import { describe, it, expect } from 'vitest';
import { DataProcessor } from './data/DataProcessor';

describe('test toolchain', () => {
    it('imports and runs project TypeScript modules', () => {
        expect(DataProcessor.convertAltitude(1000, 'km')).toBe(1);
    });
});
