import { defineConfig } from 'vitest/config';

export default defineConfig({
    // jsdom so unit tests can transitively import the PlayCanvas-backed modules
    // (which touch browser globals at load) and exercise localStorage-backed code.
    test: {
        environment: 'jsdom',
        include: ['tests/**/*.test.js']
    }
});
