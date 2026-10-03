import { defineConfig, devices } from "@playwright/test";

const origin = `http://127.0.0.1:${process.env.AGES_E2E_PORT ?? "8791"}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: {
        ...devices["iPhone 13"],
        defaultBrowserType: "chromium",
        viewport: { width: 375, height: 812 },
      },
    },
  ],
  webServer: {
    command: "node tests/e2e/start-server.mjs",
    url: `${origin}/health`,
    reuseExistingServer: false,
    timeout: 90_000,
  },
});
