import { createHash } from "node:crypto";
import path from "node:path";

import { EnvValidationError, getEnv, messagingIssues } from "./env";

// Phase 22 guest messaging configuration (policy 1). The rest of the app reads messaging
// settings only through here.

export type EmailProvider = "capture" | "smtp" | "off";
export type SmsProvider = "capture" | "twilio" | "off";

export type MessagingConfig = {
  email: { provider: EmailProvider; smtpUrl: string | null; from: string | null };
  sms: {
    provider: SmsProvider;
    twilio: { accountSid: string; authToken: string; from: string } | null;
  };
  capturePath: string;
  /** Keys the opt-out list. */
  suppressionKey: string;
  dispatchIntervalMs: number;
  maxAttempts: number;
  retentionDays: number;
  /** Public base URL for links in messages (manage, unsubscribe). */
  appBaseUrl: string;
};

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The capture folder, resolved. Like employee documents it must stay outside `public/`, so a
 * captured message can never be served.
 */
export function resolveCapturePath(configured: string, projectRoot: string = process.cwd()): string {
  const resolved = path.resolve(projectRoot, configured);

  if (isWithin(path.resolve(projectRoot, "public"), resolved)) {
    throw new Error("MESSAGING_CAPTURE_PATH must be outside the public directory.");
  }

  return resolved;
}

export type PublicBookingConfig = {
  /** Null unless a trusted proxy header is configured (the sign-in setting). */
  clientIpHeader: string | null;
  ipThreshold: number;
  contactThreshold: number;
  windowMs: number;
  /** Keys throttle rows, so no IP or contact is stored. */
  throttleKey: string;
};

/** Phase 22 policy 10: limits on the public booking page. */
export function getPublicBookingConfig(): PublicBookingConfig {
  const env = getEnv();

  return {
    clientIpHeader: env.AUTH_CLIENT_IP_HEADER ?? null,
    ipThreshold: env.PUBLIC_BOOKING_IP_THRESHOLD,
    contactThreshold: env.PUBLIC_BOOKING_CONTACT_THRESHOLD,
    windowMs: 3_600_000,
    throttleKey: getMessagingConfig().suppressionKey,
  };
}

/** Throws, naming the variables but never their values, when messaging is misconfigured. */
export function getMessagingConfig(): MessagingConfig {
  const env = getEnv();
  const issues = messagingIssues(env);

  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }

  const twilio =
    env.MESSAGING_TWILIO_ACCOUNT_SID && env.MESSAGING_TWILIO_AUTH_TOKEN && env.MESSAGING_TWILIO_FROM
      ? {
          accountSid: env.MESSAGING_TWILIO_ACCOUNT_SID,
          authToken: env.MESSAGING_TWILIO_AUTH_TOKEN,
          from: env.MESSAGING_TWILIO_FROM,
        }
      : null;

  return {
    // Unset means capture; production refuses unset (see env.ts).
    email: {
      provider: env.MESSAGING_EMAIL_PROVIDER ?? "capture",
      smtpUrl: env.MESSAGING_SMTP_URL ?? null,
      from: env.MESSAGING_FROM_EMAIL ?? null,
    },
    sms: { provider: env.MESSAGING_SMS_PROVIDER ?? "capture", twilio },
    capturePath: resolveCapturePath(env.MESSAGING_CAPTURE_PATH),
    // Outside production a missing key falls back to one derived from a fixed label, so
    // development and tests work without setup. Production requires the real key.
    suppressionKey:
      env.MESSAGING_SUPPRESSION_KEY ?? createHash("sha256").update("restaurant-ops-dev-suppression-key").digest("hex"),
    dispatchIntervalMs: env.MESSAGE_DISPATCH_INTERVAL_MS,
    maxAttempts: env.MESSAGE_MAX_ATTEMPTS,
    retentionDays: env.MESSAGE_RETENTION_DAYS,
    appBaseUrl: env.APP_BASE_URL.replace(/\/+$/, ""),
  };
}
