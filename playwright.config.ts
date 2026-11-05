import { randomBytes } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";

import { getEnv } from "./src/config/env";
import {
  isCi,
  loadLocalEnv,
  requireTestDatabaseUrl,
} from "./src/config/tooling-env";
import { E2E_DOCUMENT_STORAGE_PATH } from "./tests/helpers/e2e-storage";

loadLocalEnv();

const { APP_BASE_URL: baseURL } = getEnv();

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/helpers/global-setup.ts",
  forbidOnly: isCi(),
  retries: isCi() ? 2 : 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: baseURL,
    env: {
      DATABASE_URL: requireTestDatabaseUrl(),
      // Generated per run, so tests never depend on a developer's or a known secret.
      NEXTAUTH_SECRET: randomBytes(32).toString("base64url"),
      EMPLOYEE_DOCUMENT_STORAGE_PATH: E2E_DOCUMENT_STORAGE_PATH,
    },
    // A reused dev server would run the tests against the development database.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
