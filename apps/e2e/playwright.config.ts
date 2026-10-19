// Browser E2E (M11).
//   vps-public : read-only checks against the production site, no login (E2E_BASE_URL, default the VPS).
//   ui         : the main flows with a login. Default target = the mock web (`npm run dev:web`, started here),
//                so no real cabinet is touched. Real site: E2E_UI_URL + E2E_EMAIL/E2E_PASSWORD (+ E2E_TOTP_SECRET
//                for a 2FA account); commands are only sent when E2E_ALLOW_COMMANDS=1 (to E2E_CABINET).
import { defineConfig, devices } from '@playwright/test';

const VPS = process.env.E2E_BASE_URL ?? 'https://13-55-91-187.sslip.io';
const UI = process.env.E2E_UI_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  outputDir: 'test-results',
  use: { locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'vps-public', testMatch: /public\.spec\.ts/, use: { ...devices['Desktop Chrome'], baseURL: VPS } },
    { name: 'ui', testMatch: /ui\.spec\.ts/, use: { ...devices['Desktop Chrome'], baseURL: UI } },
  ],
  webServer: process.env.E2E_UI_URL
    ? undefined
    : { command: 'npm run dev -w @citylight/web -- --port 5173 --strictPort', cwd: '../..', url: UI, reuseExistingServer: true, timeout: 120_000 },
});
