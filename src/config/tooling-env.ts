import { loadEnvConfig } from "@next/env";

/**
 * For tools that run outside the Next.js runtime (Vitest, drizzle-kit, Playwright).
 * Next.js loads .env files itself, so application code must not import this file.
 */
export function loadLocalEnv(): void {
  loadEnvConfig(process.cwd());
}

export function isCi(): boolean {
  return Boolean(process.env.CI);
}
