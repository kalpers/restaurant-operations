import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, loginThrottles } from "@/db/schema";
import { normalizeEmail } from "@/modules/auth/email";
import { verifyCredentials } from "@/modules/auth/services/credential-service";
import { accountThrottleKey } from "@/modules/auth/services/login-throttle";
import { listUsersAtLocation, unlockUser } from "@/modules/auth/services/user-service";
import type { Actor } from "@/modules/auth/types";
import { AuthorizationError, NotFoundError } from "@/shared/errors/app-error";

import {
  actorAt,
  createOrganizationFixture,
  createRoleFixture,
  createUserFixture,
  generatePassword,
  uniqueEmail,
} from "../../fixtures/auth-fixtures";

const MINUTE = 60_000;

/** A controlled clock for each attempt. */
const clockAt = (base: Date, minutes: number) => () => new Date(base.getTime() + minutes * MINUTE);

async function throttleRow(email: string) {
  const [row] = await getDatabase()
    .select()
    .from(loginThrottles)
    .where(eq(loginThrottles.keyHash, accountThrottleKey(normalizeEmail(email))));

  return row;
}

async function eventsFor(userId: string) {
  return getDatabase()
    .select({ action: auditEvents.action, details: auditEvents.details, before: auditEvents.before, after: auditEvents.after })
    .from(auditEvents)
    .where(eq(auditEvents.entityId, userId))
    .orderBy(auditEvents.sequence);
}

describe("sign-in lockout", () => {
  let fixture: Awaited<ReturnType<typeof createOrganizationFixture>>;
  let ownerActor: Actor;

  beforeAll(async () => {
    fixture = await createOrganizationFixture(getDatabase());
    const owner = await createUserFixture(getDatabase(), {
      assignments: [{ roleId: fixture.ownerRole, locationId: fixture.locationA }],
    });
    ownerActor = await actorAt(getDatabase(), owner.id, fixture.locationA, "admin.users.manage");
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const createServer = () =>
    createUserFixture(getDatabase(), {
      assignments: [{ roleId: fixture.serverRole, locationId: fixture.locationA }],
    });

  it("locks a known account at the 5th failure; the correct password then fails identically until expiry", async () => {
    const user = await createServer();
    const base = new Date("2030-01-01T10:00:00.000Z");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(
        await verifyCredentials(getDatabase(), { email: user.email, password: generatePassword() }, { now: clockAt(base, attempt) }),
      ).toBeNull();
    }

    expect((await throttleRow(user.email))?.lockedUntil).toBeNull();
    // The 4th failure did not lock (the next test shows the correct password still works).
    expect(
      await verifyCredentials(getDatabase(), { email: user.email, password: generatePassword() }, { now: clockAt(base, 4) }),
    ).toBeNull();

    const locked = await throttleRow(user.email);

    expect(locked?.failureCount).toBe(5);
    expect(locked?.lockedUntil).toEqual(new Date(base.getTime() + 19 * MINUTE));

    // Locked: the correct password gets the same null, and the count isn't extended.
    expect(await verifyCredentials(getDatabase(), user, { now: clockAt(base, 10) })).toBeNull();
    expect(await verifyCredentials(getDatabase(), user, { now: clockAt(base, 18.99) })).toBeNull();
    expect((await throttleRow(user.email))?.failureCount).toBe(5);

    // Expired: the correct password succeeds and clears the row.
    expect(await verifyCredentials(getDatabase(), user, { now: clockAt(base, 19) })).toEqual({ id: user.id });
    expect(await throttleRow(user.email)).toBeUndefined();

    const actions = (await eventsFor(user.id)).map((event) => event.action);

    expect(actions.filter((action) => action === "auth.sign-in-failed")).toHaveLength(5);
    expect(actions.filter((action) => action === "auth.account-locked")).toHaveLength(1);
    expect(actions.at(-1)).toBe("auth.signed-in");
  });

  it("returns the same null for 4 failures then lets the correct password in, resetting the count", async () => {
    const user = await createServer();
    const base = new Date("2030-01-02T10:00:00.000Z");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await verifyCredentials(getDatabase(), { email: user.email, password: generatePassword() }, { now: clockAt(base, attempt) });
    }

    expect(await verifyCredentials(getDatabase(), user, { now: clockAt(base, 5) })).toEqual({ id: user.id });
    expect(await throttleRow(user.email)).toBeUndefined();
  });

  it("starts a new window after 15 minutes", async () => {
    const user = await createServer();
    const base = new Date("2030-01-03T10:00:00.000Z");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await verifyCredentials(getDatabase(), { email: user.email, password: generatePassword() }, { now: clockAt(base, 0) });
    }

    await verifyCredentials(getDatabase(), { email: user.email, password: generatePassword() }, { now: clockAt(base, 15) });

    const row = await throttleRow(user.email);

    expect(row?.failureCount).toBe(1);
    expect(row?.lockedUntil).toBeNull();
  });

  it("throttles an unknown email the same way and writes no audit", async () => {
    const email = uniqueEmail("nobody");
    const base = new Date("2030-01-04T10:00:00.000Z");
    const before = await getDatabase().select({ sequence: auditEvents.sequence }).from(auditEvents);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(
        await verifyCredentials(getDatabase(), { email, password: generatePassword() }, { now: clockAt(base, attempt) }),
      ).toBeNull();
    }

    const row = await throttleRow(email);

    expect(row?.failureCount).toBe(5);
    expect(row?.lockedUntil).toEqual(new Date(base.getTime() + 19 * MINUTE));
    expect(row?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await getDatabase().select({ sequence: auditEvents.sequence }).from(auditEvents)).toHaveLength(before.length);
  });

  it("counts concurrent failures exactly", async () => {
    const user = await createServer();
    const now = () => new Date("2030-01-05T10:00:00.000Z");

    await Promise.all(
      Array.from({ length: 4 }, () =>
        verifyCredentials(getDatabase(), { email: user.email, password: generatePassword() }, { now }),
      ),
    );

    const row = await throttleRow(user.email);

    expect(row?.failureCount).toBe(4);
    expect(row?.lockedUntil).toBeNull();
  });

  it("locks a disabled account too, recording DISABLED failures", async () => {
    const user = await createUserFixture(getDatabase(), {
      active: false,
      assignments: [{ roleId: fixture.serverRole, locationId: fixture.locationA }],
    });
    const now = () => new Date("2030-01-06T10:00:00.000Z");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await verifyCredentials(getDatabase(), user, { now });
    }

    expect((await throttleRow(user.email))?.lockedUntil).not.toBeNull();
    expect((await eventsFor(user.id)).map((event) => event.action)).toContain("auth.account-locked");
  });

  it("defers the failure and lock audits like auth.sign-in-failed", async () => {
    const user = await createServer();
    const deferred: (() => Promise<void>)[] = [];
    const now = () => new Date("2030-01-07T10:00:00.000Z");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await verifyCredentials(
        getDatabase(),
        { email: user.email, password: generatePassword() },
        { now, deferFailureAudit: (task) => deferred.push(task) },
      );
    }

    expect(await eventsFor(user.id)).toEqual([]);
    expect((await throttleRow(user.email))?.failureCount).toBe(5);

    for (const task of deferred) {
      await task();
    }

    expect((await eventsFor(user.id)).map((event) => event.action)).toEqual([
      ...Array(5).fill("auth.sign-in-failed"),
      "auth.account-locked",
    ]);
  });

  it("ignores the client IP unless a trusted header is configured (the default)", async () => {
    const before = (await getDatabase().select().from(loginThrottles)).length;
    const email = uniqueEmail("ip");

    await verifyCredentials(getDatabase(), { email, password: generatePassword() }, { clientIp: "203.0.113.7" });

    expect((await getDatabase().select().from(loginThrottles)).length).toBe(before + 1);
  });

  describe("administrator unlock", () => {
    async function lockedServer() {
      const user = await createServer();
      const now = () => new Date(Date.now() + 1000);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await verifyCredentials(getDatabase(), { email: user.email, password: generatePassword() }, { now });
      }

      return user;
    }

    it("shows the lock on the Users list, clears it, and records auth.account-unlocked", async () => {
      const user = await lockedServer();
      const listed = (await listUsersAtLocation(getDatabase(), fixture.locationA)).find((row) => row.id === user.id);

      expect(listed?.lockedUntil).toBeInstanceOf(Date);

      expect(await unlockUser(getDatabase(), ownerActor, { userId: user.id })).toEqual({ id: user.id, wasLocked: true });
      expect(await throttleRow(user.email)).toBeUndefined();
      expect((await listUsersAtLocation(getDatabase(), fixture.locationA)).find((row) => row.id === user.id)?.lockedUntil).toBeNull();
      expect(await verifyCredentials(getDatabase(), user)).toEqual({ id: user.id });

      const events = await eventsFor(user.id);
      const unlocked = events.filter((event) => event.action === "auth.account-unlocked");
      const serialized = JSON.stringify(events);

      expect(unlocked).toEqual([{ action: "auth.account-unlocked", details: null, before: null, after: null }]);
      expect(serialized).not.toContain(user.email);
      expect(serialized).not.toContain(user.password);
    });

    it("is refused without admin.users.manage", async () => {
      const user = await lockedServer();
      const roleId = await createRoleFixture(getDatabase(), fixture.organizationId, ["admin.users.view", "orders.create", "menu.view"]);
      const viewer = await createUserFixture(getDatabase(), { assignments: [{ roleId, locationId: fixture.locationA }] });
      const viewerActor = await actorAt(getDatabase(), viewer.id, fixture.locationA);

      await expect(unlockUser(getDatabase(), viewerActor, { userId: user.id })).rejects.toBeInstanceOf(AuthorizationError);
      expect((await throttleRow(user.email))?.lockedUntil).not.toBeNull();
    });

    it("is refused across the escalation rule and for a user at another location", async () => {
      const roleId = await createRoleFixture(getDatabase(), fixture.organizationId, [
        "admin.users.view",
        "admin.users.manage",
        "menu.view",
      ]);
      const admin = await createUserFixture(getDatabase(), { assignments: [{ roleId, locationId: fixture.locationA }] });
      const adminActor = await actorAt(getDatabase(), admin.id, fixture.locationA);
      const lockedOwner = await createUserFixture(getDatabase(), {
        assignments: [{ roleId: fixture.ownerRole, locationId: fixture.locationA }],
      });
      const elsewhere = await createUserFixture(getDatabase(), {
        assignments: [{ roleId: fixture.serverRole, locationId: fixture.locationB }],
      });

      await expect(unlockUser(getDatabase(), adminActor, { userId: lockedOwner.id })).rejects.toBeInstanceOf(AuthorizationError);
      await expect(unlockUser(getDatabase(), ownerActor, { userId: elsewhere.id })).rejects.toBeInstanceOf(NotFoundError);

      const unlockEvents = await getDatabase()
        .select()
        .from(auditEvents)
        .where(inArray(auditEvents.entityId, [lockedOwner.id, elsewhere.id]));

      expect(unlockEvents.filter((event) => event.action === "auth.account-unlocked")).toEqual([]);
    });
  });
});
