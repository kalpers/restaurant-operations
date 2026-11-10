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

const envSchema = z
  .object({
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
    // An empty value, as in a copied .env.example, counts as unset.
    NEXTAUTH_SECRET: z.preprocess(
      emptyAsUnset,
      z
        .string({ error: "must be a string" })
        .min(32, { error: "must be at least 32 characters" })
        .optional(),
    ),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV === "production" && !env.NEXTAUTH_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["NEXTAUTH_SECRET"],
        message: "is required in production",
      });
    }
  });

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
