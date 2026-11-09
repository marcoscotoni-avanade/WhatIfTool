import { defineConfig } from '@playwright/test';
const preview = process.env.PLANNER_PREVIEW === '1';
const baseURL = `http://127.0.0.1:${preview ? 1421 : 1420}`;
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL, viewport: { width: 1600, height: 1000 },
    browserName: 'chromium', channel: process.platform === 'win32' ? 'msedge' : undefined,
    trace: 'retain-on-failure',
  },
  webServer: { command: preview ? 'npm run build && npm run preview' : 'npm run dev', url: baseURL, reuseExistingServer: !process.env.CI, timeout: 120_000 },
});
