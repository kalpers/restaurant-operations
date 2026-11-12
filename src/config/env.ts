import { z } from "zod";

const DEFAULT_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** A whole number within bounds, with a default when unset. */
function wholeNumber(options: { min: number; max: number; default: number }) {
  return z.coerce
    .number({ error: "must be a whole number" })
    .int({ error: "must be a whole number" })
    .min(options.min, { error: `must be at least ${options.min}` })
    .max(options.max, { error: `must be at most ${options.max}` })
    .default(options.default);
}

const emptyAsUnset = (value: unknown) => (value === "" ? undefined : value);
const MAXIMUM_DOCUMENT_BYTES = 50 * 1024 * 1024;

const envObject = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"], {
      error: "must be one of development, test, production",
    })
    .default("development"),
  DATABASE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: "must be a postgres:// or postgresql:// URL",
  }),
  // Only test tooling reads this. Its safety rules are in src/db/maintenance.
  TEST_DATABASE_URL: z
    .url({
      protocol: /^postgres(ql)?$/,
      error: "must be a postgres:// or postgresql:// URL",
    })
    .optional(),
  APP_BASE_URL: z.url({
    protocol: /^https?$/,
    error: "must be an http:// or https:// URL",
  }),
  // Must stay outside public/. The local adapter refuses a root inside it.
  EMPLOYEE_DOCUMENT_STORAGE_PATH: z
    .string({ error: "must be a string" })
    .min(1, { error: "must not be empty" })
    .default(".local/hr-files"),
  EMPLOYEE_DOCUMENT_MAX_BYTES: z.coerce
    .number({ error: "must be a whole number" })
    .int({ error: "must be a whole number" })
    .positive({ error: "must be positive" })
    .max(MAXIMUM_DOCUMENT_BYTES, { error: "must be at most 50 MiB" })
    .default(DEFAULT_DOCUMENT_BYTES),
  // How often the outbox processor publishes committed events (README section 23).
  // 0 turns the in-process processor off.
  OUTBOX_POLL_INTERVAL_MS: z.coerce
    .number({ error: "must be a whole number" })
    .int({ error: "must be a whole number" })
    .min(0, { error: "must not be negative" })
    .max(60_000, { error: "must be at most 60000" })
    .default(1000),
  // Phase 16 outbox failure handling and retention (README section 23).
  OUTBOX_MAX_ATTEMPTS: wholeNumber({ min: 1, max: 100, default: 10 }),
  OUTBOX_RETENTION_DAYS: wholeNumber({ min: 1, max: 3650, default: 7 }),
  // How often the in-process maintenance runner purges expired rows. 0 turns it off.
  MAINTENANCE_INTERVAL_MS: wholeNumber({ min: 0, max: 86_400_000, default: 3_600_000 }),
  // Phase 16 sign-in throttling (README section 9).
  AUTH_LOCKOUT_THRESHOLD: wholeNumber({ min: 1, max: 100, default: 5 }),
  AUTH_LOCKOUT_WINDOW_MINUTES: wholeNumber({ min: 1, max: 1440, default: 15 }),
  AUTH_LOCKOUT_DURATION_MINUTES: wholeNumber({ min: 1, max: 1440, default: 15 }),
  // Set only behind a trusted proxy that writes this header (e.g. x-forwarded-for).
  // Unset, the default, means no per-IP throttling, because the header could be spoofed.
  AUTH_CLIENT_IP_HEADER: z.preprocess(
    emptyAsUnset,
    z
      .string({ error: "must be a string" })
      .regex(/^[a-z0-9-]{1,64}$/, { error: "must be a lowercase header name" })
      .optional(),
  ),
  AUTH_IP_THRESHOLD: wholeNumber({ min: 1, max: 10_000, default: 50 }),
  // Phase 22 guest messaging (README section 22). Each channel picks one adapter:
  // `capture` writes messages to files and sends nothing; `off` queues nothing.
  MESSAGING_EMAIL_PROVIDER: z.preprocess(
    emptyAsUnset,
    z.enum(["capture", "smtp", "off"], { error: "must be one of capture, smtp, off" }).optional(),
  ),
  MESSAGING_SMS_PROVIDER: z.preprocess(
    emptyAsUnset,
    z.enum(["capture", "twilio", "off"], { error: "must be one of capture, twilio, off" }).optional(),
  ),
  // Only the Playwright config sets this: CI-mode E2E runs `next start`, a production build.
  MESSAGING_ALLOW_CAPTURE_IN_PRODUCTION: z.preprocess(
    emptyAsUnset,
    z.enum(["true", "false"], { error: "must be true or false" }).default("false"),
  ),
  MESSAGING_CAPTURE_PATH: z
    .string({ error: "must be a string" })
    .min(1, { error: "must not be empty" })
    .default(".local/outbound-messages"),
  MESSAGING_FROM_EMAIL: z.preprocess(emptyAsUnset, z.email({ error: "must be an email address" }).optional()),
  MESSAGING_SMTP_URL: z.preprocess(
    emptyAsUnset,
    z.url({ protocol: /^smtps?$/, error: "must be an smtp:// or smtps:// URL" }).optional(),
  ),
  MESSAGING_TWILIO_ACCOUNT_SID: z.preprocess(
    emptyAsUnset,
    z.string().regex(/^AC[0-9a-f]{32}$/, { error: "must be a Twilio account SID (AC followed by 32 hex digits)" }).optional(),
  ),
  MESSAGING_TWILIO_AUTH_TOKEN: z.preprocess(
    emptyAsUnset,
    z.string().min(16, { error: "must be at least 16 characters" }).optional(),
  ),
  MESSAGING_TWILIO_FROM: z.preprocess(
    emptyAsUnset,
    z.string().regex(/^\+[1-9][0-9]{6,14}$/, { error: "must be an E.164 phone number such as +15551234567" }).optional(),
  ),
  // Keys the opt-out list (an HMAC of channel and address). Never rotate it: a new key would
  // stop matching existing opt-outs. Required in production when a real provider is set.
  MESSAGING_SUPPRESSION_KEY: z.preprocess(
    emptyAsUnset,
    z.string({ error: "must be a string" }).min(32, { error: "must be at least 32 characters" }).optional(),
  ),
  // Phase 22 public booking throttles (policy 10), per hour. The IP count applies only behind
  // AUTH_CLIENT_IP_HEADER; the contact count always applies.
  PUBLIC_BOOKING_IP_THRESHOLD: wholeNumber({ min: 1, max: 10_000, default: 30 }),
  PUBLIC_BOOKING_CONTACT_THRESHOLD: wholeNumber({ min: 1, max: 1000, default: 5 }),
  // How often (ms) the message dispatcher sends queued guest messages. 0 turns it off.
  MESSAGE_DISPATCH_INTERVAL_MS: wholeNumber({ min: 0, max: 60_000, default: 2000 }),
  MESSAGE_MAX_ATTEMPTS: wholeNumber({ min: 1, max: 50, default: 8 }),
  // Days a sent message keeps its address and body before maintenance clears them.
  MESSAGE_RETENTION_DAYS: wholeNumber({ min: 1, max: 3650, default: 90 }),
  // An empty value, as in a copied .env.example, counts as unset.
  NEXTAUTH_SECRET: z.preprocess(
    emptyAsUnset,
    z
      .string({ error: "must be a string" })
      .min(32, { error: "must be at least 32 characters" })
      .optional(),
  ),
});

const envSchema = envObject.superRefine((env, context) => {
  if (env.NODE_ENV === "production" && !env.NEXTAUTH_SECRET) {
    context.addIssue({
      code: "custom",
      path: ["NEXTAUTH_SECRET"],
      message: "is required in production",
    });
  }
});

type MessagingFields = Pick<
  z.infer<typeof envObject>,
  | "NODE_ENV"
  | "MESSAGING_EMAIL_PROVIDER"
  | "MESSAGING_SMS_PROVIDER"
  | "MESSAGING_ALLOW_CAPTURE_IN_PRODUCTION"
  | "MESSAGING_FROM_EMAIL"
  | "MESSAGING_SMTP_URL"
  | "MESSAGING_TWILIO_ACCOUNT_SID"
  | "MESSAGING_TWILIO_AUTH_TOKEN"
  | "MESSAGING_TWILIO_FROM"
  | "MESSAGING_SUPPRESSION_KEY"
>;

/**
 * Phase 22 policy 1 (amendment 16). Production must name each channel's adapter (no silent
 * default), may use `capture` only when tests allow it, and a real adapter needs its settings.
 * Checked when messaging is configured (`getMessagingConfig`, at server start), not in
 * `parseEnv`: `next build` runs as production, and pages that never send a message mustn't
 * fail to build for want of a provider.
 */
export function messagingIssues(env: MessagingFields): string[] {
  const production = env.NODE_ENV === "production";
  const captureAllowed = !production || env.MESSAGING_ALLOW_CAPTURE_IN_PRODUCTION === "true";
  const issues: string[] = [];
  const require = (path: keyof MessagingFields, message: string) => issues.push(`${path}: ${message}`);

  for (const key of ["MESSAGING_EMAIL_PROVIDER", "MESSAGING_SMS_PROVIDER"] as const) {
    const provider = env[key];

    if (production && provider === undefined) {
      require(key, "is required in production");
    } else if (provider === "capture" && !captureAllowed) {
      require(key, "must not be capture in production");
    }
  }

  const realProvider = env.MESSAGING_EMAIL_PROVIDER === "smtp" || env.MESSAGING_SMS_PROVIDER === "twilio";

  if (production && realProvider && !env.MESSAGING_SUPPRESSION_KEY) {
    require("MESSAGING_SUPPRESSION_KEY", "is required in production when a messaging provider is set");
  }

  if (env.MESSAGING_EMAIL_PROVIDER === "smtp") {
    if (!env.MESSAGING_SMTP_URL) require("MESSAGING_SMTP_URL", "is required when MESSAGING_EMAIL_PROVIDER is smtp");
    if (!env.MESSAGING_FROM_EMAIL) require("MESSAGING_FROM_EMAIL", "is required when MESSAGING_EMAIL_PROVIDER is smtp");
  }

  if (env.MESSAGING_SMS_PROVIDER === "twilio") {
    if (!env.MESSAGING_TWILIO_ACCOUNT_SID) require("MESSAGING_TWILIO_ACCOUNT_SID", "is required when MESSAGING_SMS_PROVIDER is twilio");
    if (!env.MESSAGING_TWILIO_AUTH_TOKEN) require("MESSAGING_TWILIO_AUTH_TOKEN", "is required when MESSAGING_SMS_PROVIDER is twilio");
    if (!env.MESSAGING_TWILIO_FROM) require("MESSAGING_TWILIO_FROM", "is required when MESSAGING_SMS_PROVIDER is twilio");
  }

  return issues;
}

export type Env = z.infer<typeof envSchema>;

/**
 * Raised when configuration is missing or malformed. The message names the
 * variables and the rule they broke, and never includes their values, because
 * those can contain credentials.
 */
export class EnvValidationError extends Error {
  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n- ${issues.join("\n- ")}`);
    this.name = "EnvValidationError";
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    );
  }

  return result.data;
}

let cachedEnv: Env | undefined;

/**
 * Validated application configuration. Parsing happens on first use rather than
 * at import, so `next build` does not need runtime variables such as DATABASE_URL.
 */
export function getEnv(): Env {
  cachedEnv ??= parseEnv(process.env);
  return cachedEnv;
}
