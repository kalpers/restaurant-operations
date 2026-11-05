import { getEnv } from "./env";

/**
 * Configuration the authentication library needs. next-auth reads NEXTAUTH_URL
 * directly from the process environment, so it is derived from APP_BASE_URL here,
 * the one place allowed to touch `process.env`.
 */
export function getAuthConfig(): { secret: string; secureCookies: boolean } {
  const env = getEnv();

  if (!env.NEXTAUTH_SECRET) {
    throw new Error(
      "NEXTAUTH_SECRET is required for sign-in. See .env.example for how to generate one.",
    );
  }

  process.env.NEXTAUTH_URL ??= env.APP_BASE_URL;

  return {
    secret: env.NEXTAUTH_SECRET,
    secureCookies: env.APP_BASE_URL.startsWith("https://"),
  };
}
