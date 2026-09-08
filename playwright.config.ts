import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/pages',
  fullyParallel: true,
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:4174/3d/',
    browserName: 'chromium',
    headless: true,
    launchOptions: {
      args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
      // Optional local override when the sandbox cannot download Playwright browsers.
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    },
  },
  webServer: {
    command: 'npm run preview:pages',
    url: 'http://127.0.0.1:4174/3d/',
    reuseExistingServer: !process.env.CI,
  },
});
