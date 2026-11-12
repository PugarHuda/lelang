import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0, // the proof panel reads the live Kite RPC
  // CI installs Playwright's Chromium; locally PW_CHANNEL=chrome reuses an installed Chrome instead of downloading one.
  use: { baseURL: 'http://localhost:4173', ...(process.env.PW_CHANNEL && { channel: process.env.PW_CHANNEL }) },
  webServer: { command: 'node scripts/serve-static.js', url: 'http://localhost:4173', reuseExistingServer: !process.env.CI },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
