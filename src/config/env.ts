import { z } from "zod";

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
    // An empty value, as in a copied .env.example, counts as unset.
    NEXTAUTH_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
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
