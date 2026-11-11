import type { Session, User } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { describe, expect, it } from "vitest";

import { sessionCallbacks, SESSION_MAX_AGE_SECONDS } from "./auth-options";
import { normalizeEmail } from "./email";
import {
  ALL_PERMISSION_CODES,
  PERMISSION_CATALOG,
} from "./permission-catalog";
import { hashPassword, verifyPassword } from "./password";
import { OWNER_ROLE_CODE, ROLE_CATALOG } from "./role-catalog";

describe("normalizeEmail", () => {
  it("makes casing differences the same identity", () => {
    expect(normalizeEmail("Kneale@Example.COM")).toBe("kneale@example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeEmail("  owner@example.com\t")).toBe("owner@example.com");
  });

  it("applies NFKC, so compatibility characters don't create a second identity", () => {
    expect(normalizeEmail("ｏｗｎｅｒ@example.com")).toBe("owner@example.com");
    expect(normalizeEmail("oﬁce@example.com")).toBe("ofice@example.com");
  });

  it("is deterministic and stable when applied twice", () => {
    const once = normalizeEmail(" MiXeD@Example.com ");

    expect(normalizeEmail(once)).toBe(once);
  });
});

describe("password hashing", () => {
  it("produces an Argon2id hash with embedded parameters", async () => {
    const hash = await hashPassword("a-long-test-passphrase");

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it("salts, so the same password hashes differently", async () => {
    const password = "a-long-test-passphrase";

    expect(await hashPassword(password)).not.toBe(await hashPassword(password));
  });

  it("verifies only the correct password", async () => {
    const hash = await hashPassword("a-long-test-passphrase");

    expect(await verifyPassword(hash, "a-long-test-passphrase")).toBe(true);
    expect(await verifyPassword(hash, "a-long-test-passphrasf")).toBe(false);
  });
});

describe("permission catalog", () => {
  it("has 132 unique codes", () => {
    expect(ALL_PERMISSION_CODES).toHaveLength(132);
    expect(new Set(ALL_PERMISSION_CODES).size).toBe(132);
  });

  it("uses the domain.action format", () => {
    for (const code of ALL_PERMISSION_CODES) {
      // A hyphen joins words within the domain (`prep-stations`) or the action.
      expect(code).toMatch(/^[a-z]+(-[a-z]+)*(\.[a-z]+(-[a-z]+)*)+$/);
    }
  });

  it("gives every permission a name and category", () => {
    for (const permission of PERMISSION_CATALOG) {
      expect(permission.name).not.toBe("");
      expect(permission.category).not.toBe("");
    }
  });

  it("uses the report codes the README and Phase 12 expect", () => {
    expect(ALL_PERMISSION_CODES).toEqual(
      expect.arrayContaining(["reports.view", "reports.sales", "reports.export"]),
    );
    expect(ALL_PERMISSION_CODES).not.toContain("reports.sales.view");
  });
});

describe("role catalog", () => {
  const permissionsOf = (code: string) =>
    ROLE_CATALOG.find((role) => role.code === code)?.permissions ?? [];

  it("defines the nine stable roles", () => {
    expect(ROLE_CATALOG.map((role) => role.code).sort()).toEqual(
      [
        "BARTENDER",
        "COOK",
        "GENERAL_MANAGER",
        "HOST",
        "INVENTORY_MANAGER",
        "MANAGER",
        "OWNER",
        "SERVER",
        "WAIT_STAFF",
      ].sort(),
    );
  });

  it("references only catalog permissions, without repeats", () => {
    for (const role of ROLE_CATALOG) {
      expect(new Set(role.permissions).size).toBe(role.permissions.length);
      for (const code of role.permissions) {
        expect(ALL_PERMISSION_CODES).toContain(code);
      }
    }
  });

  it("gives the Owner every permission", () => {
    expect(permissionsOf(OWNER_ROLE_CODE)).toEqual(ALL_PERMISSION_CODES);
  });

  it("keeps Owner-only capabilities from the General Manager", () => {
    const generalManager = permissionsOf("GENERAL_MANAGER");

    expect(generalManager).not.toContain("admin.roles.manage");
    expect(generalManager).not.toContain("organization.manage");
    expect(generalManager).not.toContain("hr.compensation.edit");
    expect(generalManager).toContain("admin.users.manage");
  });

  it("keeps restricted HR and security administration from the Manager", () => {
    const manager = permissionsOf("MANAGER");

    expect(manager).not.toContain("admin.users.manage");
    expect(manager).not.toContain("admin.roles.view");
    expect(manager).toContain("schedule.publish");

    for (const restricted of [
      "employees.create",
      "employees.edit",
      "employees.terminate",
      "hr.compensation.view",
      "hr.compensation.edit",
      "hr.disciplinary.view",
      "hr.disciplinary.manage",
      "hr.personal.view",
      "hr.personal.edit",
      "hr.documents.view",
      "hr.documents.sensitive.view",
      "hr.notes.sensitive.view",
      "hr.notes.sensitive.manage",
    ] as const) {
      expect(manager, restricted).not.toContain(restricted);
    }
  });

  it("gives the Manager the management HR tier", () => {
    const manager = permissionsOf("MANAGER");

    for (const code of [
      "employees.view",
      "hr.view",
      "hr.certifications.view",
      "hr.certifications.manage",
      "hr.performance.view",
      "hr.performance.manage",
      "hr.notes.view",
      "hr.notes.manage",
    ] as const) {
      expect(manager, code).toContain(code);
    }
  });

  it("gives floor roles no employee or HR access", () => {
    for (const role of ["SERVER", "BARTENDER", "HOST", "COOK", "WAIT_STAFF", "INVENTORY_MANAGER"]) {
      expect(
        permissionsOf(role).filter(
          (code) => code.startsWith("hr.") || code.startsWith("employees."),
        ),
        role,
      ).toEqual([]);
    }
  });

  it("gives Wait Staff no order entry", () => {
    expect(permissionsOf("WAIT_STAFF")).not.toContain("orders.create");
  });
});

describe("session token contents", () => {
  const signIn = sessionCallbacks.jwt as unknown as (args: {
    token: JWT;
    user?: Pick<User, "id">;
  }) => JWT;
  const toSession = sessionCallbacks.session as unknown as (args: {
    session: Session;
    token: JWT;
  }) => Session;

  it("lasts eight hours", () => {
    expect(SESSION_MAX_AGE_SECONDS).toBe(28_800);
  });

  it("holds only the user ID and the sign-in instant, whatever the library put in the token", () => {
    const before = Date.now();
    const token = signIn({
      token: { sub: "ignored", name: "Name", email: "person@example.com", authTime: 1 },
      user: { id: "user-1" },
    });

    expect(Object.keys(token).sort()).toEqual(["authTime", "sub"]);
    expect(token.sub).toBe("user-1");
    expect(token.authTime).toBeGreaterThanOrEqual(before);
    expect(token.authTime).toBeLessThanOrEqual(Date.now());
  });

  it("keeps the user ID and the original sign-in instant on later requests", () => {
    expect(signIn({ token: { sub: "user-1", email: "x@example.com", authTime: 1234, iat: 99 } })).toEqual({
      sub: "user-1",
      authTime: 1234,
    });
  });

  it("adds no sign-in instant to a token from before Phase 16", () => {
    expect(signIn({ token: { sub: "user-1" } })).toEqual({ sub: "user-1" });
  });

  it("exposes only the user ID in the session", () => {
    const session = toSession({
      session: {
        expires: "2026-11-05T00:00:00.000Z",
        user: { email: "person@example.com" },
      },
      token: { sub: "user-1", authTime: 1234, email: "person@example.com" },
    });

    expect(session).toEqual({
      expires: "2026-11-05T00:00:00.000Z",
      user: { id: "user-1" },
      authTime: 1234,
    });
  });
});
