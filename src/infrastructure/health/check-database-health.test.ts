import { afterEach, describe, expect, it, vi } from "vitest";

import { checkDatabaseHealth, type HealthDatabase } from "./check-database-health";

function fakeDatabase(execute: () => Promise<unknown>): HealthDatabase {
  return { execute } as unknown as HealthDatabase;
}

describe("checkDatabaseHealth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports connected when the query succeeds", async () => {
    const health = await checkDatabaseHealth(() =>
      fakeDatabase(() => Promise.resolve([])),
    );

    expect(health).toEqual({ status: "ok", database: "connected" });
  });

  it("reports unavailable without connection details when the query fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = Object.assign(
      new Error("connect ECONNREFUSED db.internal:5432 as secret_user"),
      { code: "ECONNREFUSED" },
    );

    const health = await checkDatabaseHealth(() =>
      fakeDatabase(() => Promise.reject(failure)),
    );

    expect(health).toEqual({ status: "unavailable", database: "disconnected" });

    const logged = String(log.mock.calls[0]?.[0]);
    expect(logged).toContain("ECONNREFUSED");
    expect(logged).not.toContain("db.internal");
    expect(logged).not.toContain("secret_user");
  });

  it("logs the driver error code when the failure is wrapped", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const driverError = Object.assign(new Error("connect failed"), {
      code: "ECONNREFUSED",
    });
    const wrapped = new Error("Failed query: SELECT 1", { cause: driverError });

    await checkDatabaseHealth(() => fakeDatabase(() => Promise.reject(wrapped)));

    const logged = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(logged.errorCode).toBe("ECONNREFUSED");
    expect(JSON.stringify(logged)).not.toContain("Failed query");
  });

  it("reports unavailable when the database cannot be resolved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const health = await checkDatabaseHealth(() => {
      throw new Error("Invalid environment configuration");
    });

    expect(health).toEqual({ status: "unavailable", database: "disconnected" });
  });
});
