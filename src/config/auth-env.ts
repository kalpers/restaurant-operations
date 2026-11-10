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

export type ThrottleConfig = {
  /** Keys throttle rows, so no typed email or IP is stored. Rotating it resets counters. */
  secret: string;
  threshold: number;
  windowMs: number;
  durationMs: number;
  /** Null unless a trusted proxy header is configured. */
  clientIpHeader: string | null;
  ipThreshold: number;
};

/** Sign-in throttling limits (Phase 16, README section 9). */
export function getThrottleConfig(): ThrottleConfig {
  const env = getEnv();
  const { secret } = getAuthConfig();

  return {
    secret,
    threshold: env.AUTH_LOCKOUT_THRESHOLD,
    windowMs: env.AUTH_LOCKOUT_WINDOW_MINUTES * 60_000,
    durationMs: env.AUTH_LOCKOUT_DURATION_MINUTES * 60_000,
    clientIpHeader: env.AUTH_CLIENT_IP_HEADER ?? null,
    ipThreshold: env.AUTH_IP_THRESHOLD,
  };
}
