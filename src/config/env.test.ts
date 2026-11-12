import { describe, expect, it } from "vitest";

import { EnvValidationError, messagingIssues, parseEnv } from "./env";

const validEnv = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://user:password@localhost:5432/restaurant_ops",
  APP_BASE_URL: "http://localhost:3000",
};

function errorMessageFor(source: Record<string, string | undefined>): string {
  try {
    parseEnv(source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvValidationError);
    return (error as EnvValidationError).message;
  }
  throw new Error("Expected parseEnv to throw");
}

describe("NEXTAUTH_SECRET", () => {
  const secret = "s".repeat(32);

  it("is optional outside production", () => {
    expect(parseEnv(validEnv).NEXTAUTH_SECRET).toBeUndefined();
  });

  it("treats an empty value as unset", () => {
    expect(parseEnv({ ...validEnv, NEXTAUTH_SECRET: "" }).NEXTAUTH_SECRET).toBeUndefined();
  });

  it("is required in production", () => {
    const message = errorMessageFor({ ...validEnv, NODE_ENV: "production" });

    expect(message).toContain("NEXTAUTH_SECRET: is required in production");
  });

  it("treats an empty value as missing in production", () => {
    expect(
      errorMessageFor({
        ...validEnv,
        NODE_ENV: "production",
        NEXTAUTH_SECRET: "",
      }),
    ).toContain("NEXTAUTH_SECRET");
  });

  it("is accepted in production when set", () => {
    expect(
      parseEnv({ ...validEnv, NODE_ENV: "production", NEXTAUTH_SECRET: secret })
        .NEXTAUTH_SECRET,
    ).toBe(secret);
  });

  it("rejects a short value without repeating it", () => {
    const message = errorMessageFor({ ...validEnv, NEXTAUTH_SECRET: "too-short" });

    expect(message).toContain("NEXTAUTH_SECRET: must be at least 32 characters");
    expect(message).not.toContain("too-short");
  });
});

describe("parseEnv", () => {
  it("returns validated configuration", () => {
    expect(parseEnv(validEnv)).toMatchObject(validEnv);
  });

  it("accepts the postgres:// scheme", () => {
    const databaseUrl = "postgres://user:password@localhost:5432/db";

    expect(parseEnv({ ...validEnv, DATABASE_URL: databaseUrl }).DATABASE_URL).toBe(
      databaseUrl,
    );
  });

  it("defaults NODE_ENV to development", () => {
    expect(parseEnv({ ...validEnv, NODE_ENV: undefined }).NODE_ENV).toBe(
      "development",
    );
  });

  it("ignores unrelated variables", () => {
    expect(parseEnv({ ...validEnv, UNRELATED: "value" })).not.toHaveProperty("UNRELATED");
  });

  it.each(["DATABASE_URL", "APP_BASE_URL"])("rejects a missing %s", (name) => {
    expect(errorMessageFor({ ...validEnv, [name]: undefined })).toContain(name);
  });

  it("does not require TEST_DATABASE_URL", () => {
    expect(parseEnv(validEnv).TEST_DATABASE_URL).toBeUndefined();
  });

  it("rejects a malformed TEST_DATABASE_URL without showing its value", () => {
    const message = errorMessageFor({
      ...validEnv,
      TEST_DATABASE_URL: "mysql://admin:s3cret-value@localhost/db_test",
    });

    expect(message).toContain("TEST_DATABASE_URL");
    expect(message).not.toContain("s3cret-value");
  });

  it("reports every invalid variable at once", () => {
    const message = errorMessageFor({ NODE_ENV: "staging" });

    expect(message).toContain("NODE_ENV");
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("APP_BASE_URL");
  });

  it("rejects a database URL for another database engine", () => {
    expect(
      errorMessageFor({ ...validEnv, DATABASE_URL: "mysql://localhost/db" }),
    ).toContain("DATABASE_URL");
  });

  it("rejects an APP_BASE_URL that is not http or https", () => {
    expect(
      errorMessageFor({ ...validEnv, APP_BASE_URL: "ftp://localhost" }),
    ).toContain("APP_BASE_URL");
  });

  it("never includes configuration values in the error", () => {
    const message = errorMessageFor({
      ...validEnv,
      DATABASE_URL: "mysql://admin:s3cret-value@db.internal/app",
    });

    expect(message).not.toContain("s3cret-value");
    expect(message).not.toContain("db.internal");
    expect(message).not.toContain("admin");
  });
});

describe("Phase 16 hardening settings", () => {
  it("defaults every limit when unset", () => {
    const env = parseEnv(validEnv);

    expect(env).toMatchObject({
      AUTH_LOCKOUT_THRESHOLD: 5,
      AUTH_LOCKOUT_WINDOW_MINUTES: 15,
      AUTH_LOCKOUT_DURATION_MINUTES: 15,
      AUTH_IP_THRESHOLD: 50,
      OUTBOX_MAX_ATTEMPTS: 10,
      OUTBOX_RETENTION_DAYS: 7,
      MAINTENANCE_INTERVAL_MS: 3_600_000,
    });
    expect(env.AUTH_CLIENT_IP_HEADER).toBeUndefined();
  });

  it("treats an empty client IP header as unset and accepts a lowercase header name", () => {
    expect(parseEnv({ ...validEnv, AUTH_CLIENT_IP_HEADER: "" }).AUTH_CLIENT_IP_HEADER).toBeUndefined();
    expect(parseEnv({ ...validEnv, AUTH_CLIENT_IP_HEADER: "x-forwarded-for" }).AUTH_CLIENT_IP_HEADER).toBe(
      "x-forwarded-for",
    );
  });

  it("parses configured values", () => {
    expect(
      parseEnv({ ...validEnv, AUTH_LOCKOUT_THRESHOLD: "3", MAINTENANCE_INTERVAL_MS: "0", OUTBOX_MAX_ATTEMPTS: "4" }),
    ).toMatchObject({ AUTH_LOCKOUT_THRESHOLD: 3, MAINTENANCE_INTERVAL_MS: 0, OUTBOX_MAX_ATTEMPTS: 4 });
  });

  it.each([
    ["AUTH_LOCKOUT_THRESHOLD", "0"],
    ["AUTH_LOCKOUT_THRESHOLD", "2.5"],
    ["AUTH_LOCKOUT_WINDOW_MINUTES", "abc"],
    ["AUTH_LOCKOUT_DURATION_MINUTES", "-1"],
    ["AUTH_IP_THRESHOLD", "0"],
    ["AUTH_CLIENT_IP_HEADER", "X-Forwarded-For"],
    ["OUTBOX_MAX_ATTEMPTS", "0"],
    ["OUTBOX_RETENTION_DAYS", "0"],
    ["MAINTENANCE_INTERVAL_MS", "-5"],
  ])("rejects %s=%s without echoing the value", (name, value) => {
    const message = errorMessageFor({ ...validEnv, [name]: value });

    expect(message).toContain(name);
    expect(message).not.toContain(`=${value}`);
  });
});

describe("guest messaging (Phase 22 policy 1, amendment 16)", () => {
  const production = {
    ...validEnv,
    NODE_ENV: "production",
    NEXTAUTH_SECRET: "s".repeat(32),
  };
  const twilio = {
    MESSAGING_SMS_PROVIDER: "twilio",
    MESSAGING_TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
    MESSAGING_TWILIO_AUTH_TOKEN: "secret-token-value-1234",
    MESSAGING_TWILIO_FROM: "+15551234567",
  };
  const issuesOf = (source: Record<string, string | undefined>) => messagingIssues(parseEnv(source)).join("\n");

  it("defaults both channels to unset outside production, and capture is allowed there", () => {
    const env = parseEnv(validEnv);

    expect(env.MESSAGING_EMAIL_PROVIDER).toBeUndefined();
    expect(env.MESSAGING_SMS_PROVIDER).toBeUndefined();
    expect(messagingIssues(env)).toEqual([]);
    expect(issuesOf({ ...validEnv, MESSAGING_EMAIL_PROVIDER: "capture" })).toBe("");
    expect(env.MESSAGE_DISPATCH_INTERVAL_MS).toBe(2000);
    expect(env.MESSAGE_MAX_ATTEMPTS).toBe(8);
    expect(env.MESSAGE_RETENTION_DAYS).toBe(90);
  });

  it("lets a production build parse without providers, and refuses them unset when messaging starts", () => {
    expect(() => parseEnv(production)).not.toThrow();
    expect(issuesOf(production)).toContain("MESSAGING_EMAIL_PROVIDER: is required in production");
    expect(issuesOf(production)).toContain("MESSAGING_SMS_PROVIDER: is required in production");
  });

  it("refuses capture in production unless tests allow it", () => {
    const capture = { ...production, MESSAGING_EMAIL_PROVIDER: "capture", MESSAGING_SMS_PROVIDER: "capture" };

    expect(issuesOf(capture)).toContain("MESSAGING_EMAIL_PROVIDER: must not be capture in production");
    expect(issuesOf({ ...capture, MESSAGING_ALLOW_CAPTURE_IN_PRODUCTION: "true" })).toBe("");
  });

  it("needs SMTP settings for smtp and Twilio settings for twilio", () => {
    const message = issuesOf({ ...validEnv, MESSAGING_EMAIL_PROVIDER: "smtp", MESSAGING_SMS_PROVIDER: "twilio" });

    expect(message).toContain("MESSAGING_SMTP_URL: is required");
    expect(message).toContain("MESSAGING_FROM_EMAIL: is required");
    expect(message).toContain("MESSAGING_TWILIO_ACCOUNT_SID: is required");
    expect(message).toContain("MESSAGING_TWILIO_AUTH_TOKEN: is required");
    expect(message).toContain("MESSAGING_TWILIO_FROM: is required");
  });

  it("accepts a complete SMTP and Twilio production configuration", () => {
    expect(
      issuesOf({
        ...production,
        ...twilio,
        MESSAGING_EMAIL_PROVIDER: "smtp",
        MESSAGING_SMTP_URL: "smtps://user:pass@smtp.example.com:465",
        MESSAGING_FROM_EMAIL: "bookings@example.com",
        MESSAGING_SUPPRESSION_KEY: "k".repeat(32),
      }),
    ).toBe("");
  });

  it("requires a suppression key in production when a real provider is set", () => {
    expect(issuesOf({ ...production, ...twilio, MESSAGING_EMAIL_PROVIDER: "off" })).toContain(
      "MESSAGING_SUPPRESSION_KEY: is required in production",
    );
  });

  it("names bad values without echoing them", () => {
    const message = errorMessageFor({
      ...validEnv,
      MESSAGING_SMTP_URL: "http://user:hunter2@mail.example.com",
      MESSAGING_TWILIO_ACCOUNT_SID: "not-a-sid-hunter2",
      MESSAGING_TWILIO_FROM: "5551234567",
      MESSAGE_DISPATCH_INTERVAL_MS: "-1",
    });

    expect(message).toContain("MESSAGING_SMTP_URL");
    expect(message).toContain("MESSAGING_TWILIO_ACCOUNT_SID");
    expect(message).toContain("MESSAGING_TWILIO_FROM");
    expect(message).toContain("MESSAGE_DISPATCH_INTERVAL_MS");
    expect(message).not.toContain("hunter2");
  });
});
