import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the WebATM frontend.
 *
 * Tests live next to the code they cover as `*.test.ts`. The default
 * environment is node; tests that need a DOM (localStorage, document)
 * opt in per-file with a `// @vitest-environment happy-dom` docblock.
 */
export default defineConfig({
    test: {
        include: ['src/**/*.test.ts'],
        environment: 'node',
    },
});
