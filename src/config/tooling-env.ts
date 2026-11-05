import { loadEnvConfig } from "@next/env";

/**
 * For tools that run outside the Next.js runtime (Vitest, drizzle-kit, Playwright,
 * scripts/). Next.js loads .env files itself, so application code must not import
 * this file.
 */
export function loadLocalEnv(): void {
  loadEnvConfig(process.cwd());
}

export function isCi(): boolean {
  return Boolean(process.env.CI);
}

/**
 * NODE_ENV exactly as set. `getEnv()` defaults it to development, which a
 * destructive-operation guard must not treat as an explicit statement of intent.
 */
export function readExplicitNodeEnv(): string | undefined {
  return process.env.NODE_ENV;
}

export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;

  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is required to run database tests. See .env.example.",
    );
  }

  return url;
}

/**
 * Makes `getDatabase()` in this process use the test database. Call this before
 * anything reads the configuration, because `getEnv()` caches its first result.
 */
export function pointAtTestDatabase(): void {
  process.env.DATABASE_URL = requireTestDatabaseUrl();
}
