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
  // `next dev` compiles each route on its first request. With more workers, those
  // compiles take longer than the 5-second assertion wait, and unrelated tests fail.
  workers: 2,
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
    // CI tests the production build its earlier `npm run build` step made, which is what
    // ships and has no on-demand route compiles; under `next dev` a busy runner let
    // assertions after a save time out. Locally, `next dev` needs no build first. To run
    // the CI mode locally: `npm run build`, then `CI=1 npm run test:e2e`.
    command: isCi() ? "npm run start" : "npm run dev",
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
