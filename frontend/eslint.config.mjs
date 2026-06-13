import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/', 'webpack.config.js', 'scripts/'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.ts'],
        rules: {
            // The codebase is `any`-free; keep it that way. Prefer real
            // types from src/data/types.ts or narrow structural types.
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
            ],
            'no-console': 'error',
            eqeqeq: ['error', 'smart'],
            'prefer-const': 'error'
        }
    },
    {
        // The Logger is the one sanctioned console consumer.
        files: ['src/utils/Logger.ts'],
        rules: { 'no-console': 'off' }
    }
);
