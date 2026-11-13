import { randomBytes } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";

import { getEnv } from "./src/config/env";
import {
  isCi,
  loadLocalEnv,
  requireTestDatabaseUrl,
} from "./src/config/tooling-env";
import { E2E_DOCUMENT_STORAGE_PATH, E2E_MESSAGE_CAPTURE_PATH } from "./tests/helpers/e2e-storage";

loadLocalEnv();

const { APP_BASE_URL: baseURL } = getEnv();

export default defineConfig({
  testDir: "./tests/e2e",
  forbidOnly: isCi(),
  retries: isCi() ? 2 : 0,
  // `next dev` compiles each route on its first request. With more workers, those
  // compiles take longer than the 5-second assertion wait, and unrelated tests fail.
  workers: 2,
  reporter: "list",
  // Phase 23: under `next dev`, requests every route once so it compiles before the tests.
  globalSetup: "./tests/helpers/e2e-warm-up.ts",
  // Phase 24 policy 17: under `next dev`, saves that recompile a route still sometimes run
  // past 5 seconds after the warm-up. CI mode (production build) keeps the 5-second wait.
  expect: { timeout: isCi() ? 5_000 : 15_000 },
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
    //
    // The command recreates, migrates and seeds the test database before it starts the
    // app (Playwright starts the web server before any globalSetup), then runs the app
    // with DATABASE_URL pointing at the test database.
    command: `npx tsx tests/helpers/e2e-web-server.ts ${isCi() ? "start" : "dev"}`,
    url: baseURL,
    env: {
      // Checked here so a missing TEST_DATABASE_URL fails before anything starts.
      TEST_DATABASE_URL: requireTestDatabaseUrl(),
      // Generated per run, so tests never depend on a developer's or a known secret.
      NEXTAUTH_SECRET: randomBytes(32).toString("base64url"),
      EMPLOYEE_DOCUMENT_STORAGE_PATH: E2E_DOCUMENT_STORAGE_PATH,
      // Phase 22: guest messages are captured to files, never sent. CI mode serves a
      // production build (`next start`), which allows capture only with this switch.
      MESSAGING_EMAIL_PROVIDER: "capture",
      MESSAGING_SMS_PROVIDER: "capture",
      MESSAGING_ALLOW_CAPTURE_IN_PRODUCTION: "true",
      MESSAGING_CAPTURE_PATH: E2E_MESSAGE_CAPTURE_PATH,
      MESSAGE_DISPATCH_INTERVAL_MS: "250",
    },
    // A reused dev server would run the tests against the development database.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
