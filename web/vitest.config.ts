import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Pure-logic unit tests (API client, form validation, source mapping, rules
// parsing). No tldraw / React rendering here — see web/e2e for browser tests.
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});
