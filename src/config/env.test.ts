import { describe, expect, it } from "vitest";

import { EnvValidationError, parseEnv } from "./env";

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

describe("parseEnv", () => {
  it("returns validated configuration", () => {
    expect(parseEnv(validEnv)).toEqual(validEnv);
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
    expect(parseEnv({ ...validEnv, UNRELATED: "value" })).toEqual(validEnv);
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
