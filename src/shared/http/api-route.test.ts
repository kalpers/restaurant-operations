import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  AuthenticationError,
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { apiRoute, parseJsonBody, parseWith } from "./api-route";

const context = { params: Promise.resolve({}) };
const meta = { module: "test", operation: "test" };
const request = () => new Request("http://localhost/test");

function routeThrowing(error: unknown) {
  return apiRoute(meta, async () => {
    throw error;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("apiRoute", () => {
  it("returns the handler's body and status", async () => {
    const route = apiRoute(meta, async () => ({
      body: { id: "1" },
      status: 201,
    }));
    const response = await route(request(), context);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "1" });
  });

  it("returns 204 when there is no body", async () => {
    const response = await apiRoute(meta, async () => ({}))(request(), context);

    expect(response.status).toBe(204);
  });

  it.each([
    [new AuthenticationError(), 401, "AUTHENTICATION_REQUIRED"],
    [new AuthorizationError(), 403, "PERMISSION_DENIED"],
    [new ValidationError(), 400, "VALIDATION_FAILED"],
    [new NotFoundError("user"), 404, "NOT_FOUND"],
    [new ConflictError("TAKEN", "Taken."), 409, "TAKEN"],
    [new BusinessRuleError("RULE", "Rule."), 422, "RULE"],
    [new ConcurrencyError("user", "1"), 409, "CONCURRENCY_CONFLICT"],
  ])("maps %o to its status and code", async (error, status, code) => {
    const response = await routeThrowing(error)(request(), context);
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };

    expect(response.status).toBe(status);
    expect(body.error.code).toBe(code);
    expect(body.error.message).toBe(error.message);
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("hides unexpected errors from the client and logs only name and code", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "SELECT password_hash FROM users WHERE secret";
    const response = await routeThrowing(
      Object.assign(new Error(secret), { code: "42P01" }),
    )(request(), context);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain(secret);
    expect(JSON.parse(text).error.code).toBe("INTERNAL_ERROR");

    const line = String(log.mock.calls[0]?.[0]);
    expect(line).not.toContain(secret);
    expect(JSON.parse(line)).toMatchObject({
      severity: "error",
      errorName: "Error",
      errorCode: "42P01",
    });
  });
});

describe("request parsing", () => {
  const schema = z.object({ password: z.string().min(14) });

  it("returns valid data", () => {
    expect(parseWith(schema, { password: "x".repeat(14) })).toEqual({
      password: "x".repeat(14),
    });
  });

  it("names the field and never echoes the value", () => {
    const attempt = () => parseWith(schema, { password: "short-secret" });

    expect(attempt).toThrow(ValidationError);
    expect(attempt).toThrow("password");
    expect(attempt).not.toThrow("short-secret");
  });

  it("rejects a body that isn't JSON", async () => {
    await expect(
      parseJsonBody(
        new Request("http://localhost", { method: "POST", body: "{not json" }),
        schema,
      ),
    ).rejects.toThrow(ValidationError);
  });
});
