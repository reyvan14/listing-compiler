import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const HERE = import.meta.dirname;

// E2E runs against the production-like build: FastAPI serves web/dist.
// Run `yarn vite build` first so web/dist exists.
const PORT = 8799;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [
    { name: 'desktop-1440', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'desktop-1280', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } } },
  ],
  webServer: {
    command: `python3 -m uvicorn app:app --host 127.0.0.1 --port ${PORT} --log-level warning`,
    cwd: path.resolve(HERE, '../api'),
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
