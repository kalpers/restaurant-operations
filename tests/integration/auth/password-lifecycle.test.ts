import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, loginThrottles, users } from "@/db/schema";
import { normalizeEmail } from "@/modules/auth/email";
import { verifyPassword } from "@/modules/auth/password";
import { verifyCredentials } from "@/modules/auth/services/credential-service";
import { accountThrottleKey } from "@/modules/auth/services/login-throttle";
import { changeOwnPassword, resetUserPassword } from "@/modules/auth/services/password-service";
import { getUserAuthContext } from "@/modules/auth/services/permission-service";
import type { Actor } from "@/modules/auth/types";
import { AuthorizationError, BusinessRuleError, NotFoundError, ValidationError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import {
  actorAt,
  createOrganizationFixture,
  createRoleFixture,
  createUserFixture,
  findUserRow,
  generatePassword,
} from "../../fixtures/auth-fixtures";

// The guards read the session through these modules; the tests stand in for a request.
const session = vi.hoisted(() => ({ current: null as { userId: string; authTime?: number } | null }));

vi.mock("@/modules/auth/session", () => ({
  getSessionIdentity: async () => session.current,
  getSessionUserId: async () => session.current?.userId ?? null,
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

const { requireApiPermission, requireCurrentUserAllowingPasswordChange, requirePageUser } = await import(
  "@/modules/auth/guards"
);

async function eventsFor(userId: string) {
  return getDatabase()
    .select({ action: auditEvents.action, details: auditEvents.details, before: auditEvents.before, after: auditEvents.after })
    .from(auditEvents)
    .where(eq(auditEvents.entityId, userId))
    .orderBy(auditEvents.sequence);
}

describe("password lifecycle", () => {
  let fixture: Awaited<ReturnType<typeof createOrganizationFixture>>;
  let ownerActor: Actor;
  let owner: Awaited<ReturnType<typeof createUserFixture>>;
  const logged: string[] = [];

  beforeAll(async () => {
    fixture = await createOrganizationFixture(getDatabase());
    owner = await createUserFixture(getDatabase(), {
      assignments: [{ roleId: fixture.ownerRole, locationId: fixture.locationA }],
    });
    ownerActor = await actorAt(getDatabase(), owner.id, fixture.locationA, "admin.users.manage");

    for (const method of ["log", "error", "warn", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
  });

  beforeEach(() => {
    session.current = null;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await closeDatabase();
  });

  const createServer = () =>
    createUserFixture(getDatabase(), {
      assignments: [{ roleId: fixture.serverRole, locationId: fixture.locationA }],
    });

  describe("self-service change", () => {
    it("refuses a wrong current password and counts it toward lockout", async () => {
      const user = await createServer();

      await expect(
        changeOwnPassword(getDatabase(), user.id, { currentPassword: generatePassword(), newPassword: generatePassword() }),
      ).rejects.toMatchObject({ code: "CURRENT_PASSWORD_INCORRECT" });

      const [row] = await getDatabase()
        .select()
        .from(loginThrottles)
        .where(eq(loginThrottles.keyHash, accountThrottleKey(normalizeEmail(user.email))));

      expect(row?.failureCount).toBe(1);
    });

    it("locks after 5 wrong current passwords, auditing the lock, and then refuses even the right one", async () => {
      const user = await createServer();
      const now = () => new Date(Date.now() + 1000);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(
          changeOwnPassword(getDatabase(), user.id, { currentPassword: generatePassword(), newPassword: generatePassword() }, { now }),
        ).rejects.toBeInstanceOf(BusinessRuleError);
      }

      await expect(
        changeOwnPassword(getDatabase(), user.id, { currentPassword: user.password, newPassword: generatePassword() }, { now }),
      ).rejects.toMatchObject({ code: "ACCOUNT_TEMPORARILY_LOCKED" });
      expect((await eventsFor(user.id)).map((event) => event.action)).toContain("auth.account-locked");
      expect(await verifyCredentials(getDatabase(), user, { now })).toBeNull();
    });

    it("refuses a too-short or unchanged new password", async () => {
      const user = await createServer();

      await expect(
        changeOwnPassword(getDatabase(), user.id, { currentPassword: user.password, newPassword: "short" }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        changeOwnPassword(getDatabase(), user.id, { currentPassword: user.password, newPassword: user.password }),
      ).rejects.toMatchObject({ code: "PASSWORD_UNCHANGED" });
    });

    it("replaces the hash, sets password_changed_at, bumps the version, audits, and ends older sessions", async () => {
      const user = await createServer();
      const before = await findUserRow(getDatabase(), user.id);
      const signedInBefore = Date.now() - 1000;
      const newPassword = generatePassword();

      // Signed in before the change: valid now.
      expect(await getUserAuthContext(getDatabase(), user.id, { session: { authTime: signedInBefore } })).not.toBeNull();
      // A pre-Phase 16 token without authTime: valid until a change.
      expect(await getUserAuthContext(getDatabase(), user.id, { session: {} })).not.toBeNull();

      const result = await changeOwnPassword(getDatabase(), user.id, { currentPassword: user.password, newPassword });
      const after = await findUserRow(getDatabase(), user.id);

      expect(after.passwordHash).not.toBe(before.passwordHash);
      expect(await verifyPassword(after.passwordHash, newPassword)).toBe(true);
      expect(after.passwordChangedAt).toEqual(result.passwordChangedAt);
      expect(after.mustChangePassword).toBe(false);
      expect(after.version).toBe(before.version + 1);

      // Older sessions end; the fresh session (signed in at the change instant) is valid.
      expect(await getUserAuthContext(getDatabase(), user.id, { session: { authTime: signedInBefore } })).toBeNull();
      expect(await getUserAuthContext(getDatabase(), user.id, { session: {} })).toBeNull();
      expect(
        await getUserAuthContext(getDatabase(), user.id, { session: { authTime: result.passwordChangedAt.getTime() } }),
      ).not.toBeNull();

      // The old password fails and the new one signs in.
      expect(await verifyCredentials(getDatabase(), user)).toBeNull();
      expect(await verifyCredentials(getDatabase(), { email: user.email, password: newPassword })).toEqual({ id: user.id });

      const events = await eventsFor(user.id);

      expect(events.filter((event) => event.action === "auth.password-changed")).toEqual([
        { action: "auth.password-changed", details: null, before: null, after: null },
      ]);
      expect(JSON.stringify(events)).not.toContain(newPassword);
      expect(JSON.stringify(events)).not.toContain(user.password);
    });

    it("the guard rejects a session older than the change like a disabled user's (401)", async () => {
      const user = await createServer();
      const signedIn = Date.now() - 1000;

      session.current = { userId: user.id, authTime: signedIn };
      await expect(requireApiPermission("menu.view", fixture.locationA)).resolves.toMatchObject({ userId: user.id });

      await changeOwnPassword(getDatabase(), user.id, { currentPassword: user.password, newPassword: generatePassword() });
      await expect(requireApiPermission("menu.view", fixture.locationA)).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
      await expect(requirePageUser()).rejects.toThrow("REDIRECT:/login");
    });
  });

  describe("administrator reset", () => {
    it("returns a one-time password, forces a change, ends sessions, clears the lockout, and never logs or audits it", async () => {
      const user = await createServer();
      const signedIn = Date.now() - 1000;
      const now = () => new Date(Date.now() + 1000);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await verifyCredentials(getDatabase(), { email: user.email, password: generatePassword() }, { now });
      }

      logged.length = 0;

      const result = await resetUserPassword(getDatabase(), ownerActor, { userId: user.id, expectedVersion: user.version });
      const row = await findUserRow(getDatabase(), user.id);

      expect(result.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(result.version).toBe(user.version + 1);
      expect(row.mustChangePassword).toBe(true);
      expect(row.passwordChangedAt).toBeInstanceOf(Date);
      expect(await verifyPassword(row.passwordHash, result.temporaryPassword)).toBe(true);
      expect(row.passwordHash).not.toContain(result.temporaryPassword);
      expect(await getUserAuthContext(getDatabase(), user.id, { session: { authTime: signedIn } })).toBeNull();

      // The lockout was cleared, so the temporary password signs in.
      expect(await verifyCredentials(getDatabase(), { email: user.email, password: result.temporaryPassword })).toEqual({ id: user.id });

      const events = await eventsFor(user.id);
      const resetEvents = events.filter((event) => event.action === "admin.user-password-reset");

      expect(resetEvents).toEqual([{ action: "admin.user-password-reset", details: null, before: null, after: null }]);
      expect(JSON.stringify(events)).not.toContain(result.temporaryPassword);
      expect(logged.join("\n")).not.toContain(result.temporaryPassword);
      expect(logged.join("\n")).not.toContain(user.email);
    });

    it("forces the change on every API and page guard until the user changes it", async () => {
      const user = await createServer();
      const { temporaryPassword } = await resetUserPassword(getDatabase(), ownerActor, {
        userId: user.id,
        expectedVersion: user.version,
      });

      session.current = { userId: user.id, authTime: Date.now() + 1000 };

      const refusal = await requireApiPermission("menu.view", fixture.locationA).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(AuthorizationError);
      expect(refusal).toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED", httpStatus: 403 });
      await expect(requirePageUser()).rejects.toThrow("REDIRECT:/account/password");

      // The change endpoint's guard still lets them through.
      await expect(requireCurrentUserAllowingPasswordChange()).resolves.toMatchObject({ mustChangePassword: true });

      const changed = await changeOwnPassword(getDatabase(), user.id, {
        currentPassword: temporaryPassword,
        newPassword: generatePassword(),
      });

      session.current = { userId: user.id, authTime: changed.passwordChangedAt.getTime() };
      await expect(requireApiPermission("menu.view", fixture.locationA)).resolves.toMatchObject({ userId: user.id });
      await expect(requirePageUser()).resolves.toMatchObject({ mustChangePassword: false });
    });

    it("is refused on the actor's own account, without permission, across the escalation rule, and elsewhere", async () => {
      const ownerRow = await findUserRow(getDatabase(), owner.id);

      await expect(
        resetUserPassword(getDatabase(), ownerActor, { userId: owner.id, expectedVersion: ownerRow.version }),
      ).rejects.toMatchObject({ code: "SELF_PASSWORD_RESET_NOT_ALLOWED" });

      const target = await createServer();
      const viewRole = await createRoleFixture(getDatabase(), fixture.organizationId, ["admin.users.view", "orders.create", "menu.view"]);
      const viewer = await createUserFixture(getDatabase(), { assignments: [{ roleId: viewRole, locationId: fixture.locationA }] });

      await expect(
        resetUserPassword(getDatabase(), await actorAt(getDatabase(), viewer.id, fixture.locationA), {
          userId: target.id,
          expectedVersion: target.version,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);

      const adminRole = await createRoleFixture(getDatabase(), fixture.organizationId, ["admin.users.view", "admin.users.manage", "menu.view"]);
      const admin = await createUserFixture(getDatabase(), { assignments: [{ roleId: adminRole, locationId: fixture.locationA }] });
      const otherOwner = await createUserFixture(getDatabase(), {
        assignments: [{ roleId: fixture.ownerRole, locationId: fixture.locationA }],
      });

      await expect(
        resetUserPassword(getDatabase(), await actorAt(getDatabase(), admin.id, fixture.locationA), {
          userId: otherOwner.id,
          expectedVersion: otherOwner.version,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);

      const elsewhere = await createUserFixture(getDatabase(), {
        assignments: [{ roleId: fixture.serverRole, locationId: fixture.locationB }],
      });

      await expect(
        resetUserPassword(getDatabase(), ownerActor, { userId: elsewhere.id, expectedVersion: elsewhere.version }),
      ).rejects.toBeInstanceOf(NotFoundError);

      for (const id of [target.id, otherOwner.id, elsewhere.id]) {
        expect((await findUserRow(getDatabase(), id)).mustChangePassword).toBe(false);
      }
    });

    it("returns a conflict on a stale version and changes nothing", async () => {
      const user = await createServer();
      const before = await findUserRow(getDatabase(), user.id);

      await getDatabase().update(users).set({ version: before.version + 1 }).where(eq(users.id, user.id));

      await expect(
        resetUserPassword(getDatabase(), ownerActor, { userId: user.id, expectedVersion: before.version }),
      ).rejects.toBeInstanceOf(ConcurrencyError);

      const after = await findUserRow(getDatabase(), user.id);

      expect(after.passwordHash).toBe(before.passwordHash);
      expect(after.mustChangePassword).toBe(false);
      expect((await eventsFor(user.id)).filter((event) => event.action === "admin.user-password-reset")).toEqual([]);
    });
  });
});
