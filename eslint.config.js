import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        ignores: ['dist/**', 'node_modules/**', 'firmware/**']
    },
    js.configs.recommended,
    {
        // Application source — runs in the browser.
        files: ['src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            // __KIOSK__ (vite `define`) is declared per-file via /* global */ comments.
            globals: globals.browser
        }
    },
    {
        // Tooling / tests / config — run in Node (Vitest provides a jsdom env).
        files: ['*.config.js', 'tests/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.browser
            }
        }
    }
];
