import { defineConfig } from "@playwright/test";

import { createBrowserProcessEnvironment } from "./tests/helpers/browser-process-environment";
import { safeE2EEnvironment as safeEnvironment } from "./tests/helpers/e2e-environment";
import { createPlaywrightWebServerEnvironmentOverlay } from "./tests/helpers/playwright-web-server";

const publicBaseUrl = safeEnvironment.publicBaseUrl;
const backofficeBaseUrl = safeEnvironment.backofficeBaseUrl;
const browserProcessEnvironment = createBrowserProcessEnvironment(process.env);
const webServerEnvironment = createPlaywrightWebServerEnvironmentOverlay(process.env);
const posixGracefulWebServerShutdown = {
  gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
} satisfies {
  gracefulShutdown: { signal: "SIGINT" | "SIGTERM"; timeout: number };
};
const gracefulWebServerShutdown =
  process.platform === "win32" ? {} : posixGracefulWebServerShutdown;

export default defineConfig({
  expect: { timeout: 5_000 },
  forbidOnly: true,
  fullyParallel: false,
  globalSetup: "./tests/helpers/e2e-database-preflight.ts",
  outputDir: ".artifacts/test-results",
  preserveOutput: "failures-only",
  projects: [
    {
      name: "desktop-chromium",
      testMatch: /(?:smoke|regression)\/.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { height: 900, width: 1440 },
      },
    },
    {
      name: "mobile-chromium-390",
      testMatch: /(?:smoke|regression)\/.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        hasTouch: true,
        isMobile: true,
        viewport: { height: 844, width: 390 },
      },
    },
    {
      name: "narrow-chromium-320",
      testMatch: /(?:smoke|regression)\/.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        hasTouch: true,
        isMobile: true,
        viewport: { height: 720, width: 320 },
      },
    },
    {
      name: "compact-height-chromium",
      testMatch: /(?:smoke|regression)\/.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { height: 600, width: 1024 },
      },
    },
    {
      name: "critical-chromium",
      testMatch: /critical\/.*\.spec\.ts/,
      use: { browserName: "chromium", viewport: { height: 900, width: 1440 } },
    },
    {
      name: "critical-firefox",
      testMatch: /critical\/.*\.spec\.ts/,
      use: { browserName: "firefox", viewport: { height: 900, width: 1440 } },
    },
    {
      name: "critical-webkit",
      testMatch: /critical\/.*\.spec\.ts/,
      use: { browserName: "webkit", viewport: { height: 900, width: 1440 } },
    },
    {
      name: "backoffice-chromium",
      testMatch: /backoffice\/.*\.spec\.ts/,
      use: {
        baseURL: backofficeBaseUrl,
        browserName: "chromium",
        viewport: { height: 900, width: 1440 },
      },
    },
    {
      name: "axe-desktop-chromium",
      testMatch: /accessibility\/.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        colorScheme: "light",
        viewport: { height: 900, width: 1440 },
      },
    },
    {
      name: "axe-mobile-chromium",
      testMatch: /accessibility\/.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        colorScheme: "light",
        hasTouch: true,
        isMobile: true,
        viewport: { height: 844, width: 390 },
      },
    },
    {
      name: "axe-narrow-chromium",
      testMatch: /accessibility\/.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        colorScheme: "light",
        hasTouch: true,
        isMobile: true,
        viewport: { height: 720, width: 320 },
      },
    },
    {
      name: "axe-dark-chromium",
      testMatch: /accessibility\/.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        colorScheme: "dark",
        viewport: { height: 900, width: 1440 },
      },
    },
    {
      name: "safe-area-mobile-chromium",
      testMatch: /device\/.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        colorScheme: "light",
        hasTouch: true,
        isMobile: true,
        viewport: { height: 844, width: 390 },
      },
    },
    ...(["chromium", "firefox", "webkit"] as const).map((browserName) => ({
      name: `zoom-200-reflow-${browserName}`,
      testMatch: /reflow\/.*\.spec\.ts/,
      use: {
        browserName,
        deviceScaleFactor: 2,
        viewport: { height: 360, width: 160 },
      },
    })),
  ],
  reporter: [["line"], ["html", { open: "never", outputFolder: ".artifacts/playwright-report" }]],
  retries: 0,
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: publicBaseUrl,
    launchOptions: { env: browserProcessEnvironment },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run dev",
      env: webServerEnvironment,
      ...gracefulWebServerShutdown,
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 120_000,
      url: `${publicBaseUrl}/api/health/live`,
    },
    {
      command: "npm run dev:backoffice",
      env: webServerEnvironment,
      ...gracefulWebServerShutdown,
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 120_000,
      url: `${backofficeBaseUrl}/api/health/live`,
    },
  ],
  workers: 1,
});
