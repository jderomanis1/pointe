import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /live-production-followup\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: true,
  retries: 1,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results/live-production',
  reporter: [
    ['list'],
    ['json', { outputFile: 'qa-artifacts/playwright-results.json' }],
    ['html', { outputFolder: 'qa-artifacts/playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: process.env.QA_BASE_URL ?? 'https://pointe.team',
    browserName: 'chromium',
    trace: 'on',
    screenshot: 'off',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'production-followup', use: { ...devices['Desktop Chrome'] } },
  ],
});
