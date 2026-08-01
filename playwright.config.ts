import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:4173";
const continuousIntegration = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: continuousIntegration,
  retries: continuousIntegration ? 2 : 0,
  workers: continuousIntegration ? 1 : undefined,
  reporter: "line",
  outputDir: "test-results",
  expect: {
    timeout: 10_000
  },
  use: {
    baseURL,
    trace: "off",
    screenshot: "off",
    video: "off"
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173 --strictPort",
    url: baseURL,
    reuseExistingServer: !continuousIntegration,
    timeout: 120_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
