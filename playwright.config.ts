import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:43917";
const continuousIntegration = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: continuousIntegration,
  retries: continuousIntegration ? 2 : 0,
  workers: continuousIntegration ? 1 : 2,
  reporter: "line",
  outputDir: "test-results",
  expect: {
    timeout: 10_000
  },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off"
  },
  webServer: {
    command:
      "npm run build:verify && npm run preview -- --host 127.0.0.1 --port 43917 --strictPort",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] }
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] }
    }
  ]
});
