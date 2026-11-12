import { randomBytes, randomUUID } from "node:crypto";

import { count, eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireTestDatabaseUrl } from "@/config/tooling-env";
import { closeDatabase, getDatabase } from "@/db";
import { idempotencyRecords, loginThrottles, outboxEvents } from "@/db/schema";
import { MAINTENANCE_LOCK_KEY, runMaintenance } from "@/infrastructure/maintenance/run-maintenance";

import { createOrganizationFixture, createUserFixture } from "../../fixtures/auth-fixtures";

const DAY = 86_400_000;
const MINUTE = 60_000;

describe("runMaintenance", () => {
  const now = new Date("2031-06-01T12:00:00.000Z");
  let fixture: Awaited<ReturnType<typeof createOrganizationFixture>>;
  const ids: Record<string, string> = {};
  const keys: Record<string, string> = {};
  let idempotencyBefore: unknown[];

  async function insertEvent(name: string, state: { publishedAt?: Date | null; failedAt?: Date | null }) {
    const [row] = await getDatabase()
      .insert(outboxEvents)
      .values({
        organizationId: fixture.organizationId,
        eventType: "order.closed",
        aggregateType: "order",
        aggregateId: randomUUID(),
        payload: {},
        occurredAt: new Date(now.getTime() - 30 * DAY),
        publishedAt: state.publishedAt ?? null,
        failedAt: state.failedAt ?? null,
      })
      .returning({ id: outboxEvents.id });

    ids[name] = row!.id;
  }

  async function insertThrottle(name: string, windowStartedAt: Date, lockedUntil: Date | null) {
    const keyHash = randomBytes(32).toString("hex");

    await getDatabase()
      .insert(loginThrottles)
      .values({ keyHash, failureCount: 3, windowStartedAt, lockedUntil, updatedAt: windowStartedAt });
    keys[name] = keyHash;
  }

  beforeAll(async () => {
    fixture = await createOrganizationFixture(getDatabase());
    const actor = await createUserFixture(getDatabase());

    await insertEvent("oldPublished", { publishedAt: new Date(now.getTime() - 8 * DAY) });
    await insertEvent("recentPublished", { publishedAt: new Date(now.getTime() - 6 * DAY) });
    await insertEvent("unpublished", {});
    await insertEvent("deadLettered", { failedAt: new Date(now.getTime() - 60 * DAY) });

    await insertThrottle("expired", new Date(now.getTime() - 20 * MINUTE), null);
    await insertThrottle("expiredLock", new Date(now.getTime() - 40 * MINUTE), new Date(now.getTime() - 5 * MINUTE));
    await insertThrottle("activeWindow", new Date(now.getTime() - 5 * MINUTE), null);
    await insertThrottle("activeLock", new Date(now.getTime() - 20 * MINUTE), new Date(now.getTime() + 1 * MINUTE));

    // An old idempotency record: never purged, however old.
    await getDatabase().insert(idempotencyRecords).values({
      organizationId: fixture.organizationId,
      scope: "orders.send",
      idempotencyKey: randomUUID(),
      actorUserId: actor.id,
      requestFingerprint: "f".repeat(64),
      response: { ok: true },
      createdAt: new Date(now.getTime() - 365 * DAY),
    });
    idempotencyBefore = await getDatabase().select().from(idempotencyRecords).orderBy(idempotencyRecords.id);
  });

  afterAll(async () => {
    await getDatabase().transaction(async (transaction) => {
      await transaction.execute("SET LOCAL session_replication_role = replica" as never);
      await transaction.delete(outboxEvents).where(eq(outboxEvents.organizationId, fixture.organizationId));
      await transaction.delete(idempotencyRecords).where(eq(idempotencyRecords.organizationId, fixture.organizationId));
    });
    await getDatabase().delete(loginThrottles).where(inArray(loginThrottles.keyHash, Object.values(keys)));
    await closeDatabase();
  });

  it("does nothing while another runner holds the lock", async () => {
    const other = postgres(requireTestDatabaseUrl(), { max: 1, onnotice: () => {} });

    try {
      await other`SELECT pg_advisory_lock(${MAINTENANCE_LOCK_KEY})`;
      expect(await runMaintenance(getDatabase(), now, { retentionDays: 7, throttleWindowMs: 15 * MINUTE, notify: false })).toEqual({ skipped: true });
      expect(await getDatabase().select({ id: outboxEvents.id }).from(outboxEvents).where(eq(outboxEvents.id, ids.oldPublished!))).toHaveLength(1);
    } finally {
      await other`SELECT pg_advisory_unlock(${MAINTENANCE_LOCK_KEY})`;
      await other.end();
    }
  });

  it("deletes only published outbox rows past retention and expired throttle rows, in batches", async () => {
    const result = await runMaintenance(getDatabase(), now, { retentionDays: 7, throttleWindowMs: 15 * MINUTE, batchSize: 1, notify: false });

    expect(result.skipped).toBe(false);

    const remainingEvents = (
      await getDatabase()
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(eq(outboxEvents.organizationId, fixture.organizationId))
    ).map((row) => row.id);

    expect(remainingEvents.sort()).toEqual([ids.recentPublished, ids.unpublished, ids.deadLettered].sort());

    const remainingKeys = (
      await getDatabase()
        .select({ keyHash: loginThrottles.keyHash })
        .from(loginThrottles)
        .where(inArray(loginThrottles.keyHash, Object.values(keys)))
    ).map((row) => row.keyHash);

    expect(remainingKeys.sort()).toEqual([keys.activeWindow, keys.activeLock].sort());

    if (!result.skipped) {
      // Other files may leave published rows too; at least ours were counted.
      expect(result.outboxEventsDeleted).toBeGreaterThanOrEqual(1);
      expect(result.loginThrottlesDeleted).toBeGreaterThanOrEqual(2);
    }
  });

  it("leaves every idempotency record untouched", async () => {
    expect(await getDatabase().select().from(idempotencyRecords).orderBy(idempotencyRecords.id)).toEqual(idempotencyBefore);
  });

  it("is idempotent: a second run deletes nothing of ours", async () => {
    await runMaintenance(getDatabase(), now, { retentionDays: 7, throttleWindowMs: 15 * MINUTE, notify: false });

    const [events] = await getDatabase()
      .select({ total: count() })
      .from(outboxEvents)
      .where(eq(outboxEvents.organizationId, fixture.organizationId));

    expect(events?.total).toBe(3);
  });

  it("releases its lock, so the next run proceeds", async () => {
    expect((await runMaintenance(getDatabase(), now, { retentionDays: 7, notify: false })).skipped).toBe(false);
  });
});
