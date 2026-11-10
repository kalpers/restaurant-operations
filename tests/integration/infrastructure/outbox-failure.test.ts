import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, outboxEvents } from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import { processOutboxBatch, writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import { getSystemHealth, retryDeadLetteredEvent } from "@/modules/auth/services/system-health-service";
import type { Actor } from "@/modules/auth/types";
import { AuthorizationError, NotFoundError } from "@/shared/errors/app-error";

import {
  actorAt,
  createOrganizationFixture,
  createRoleFixture,
  createUserFixture,
} from "../../fixtures/auth-fixtures";

const PAYLOAD_MARKER = `payload-marker-${randomUUID()}`;

describe("outbox failure handling and System health", () => {
  let fixture: Awaited<ReturnType<typeof createOrganizationFixture>>;
  let owner: Actor;
  let viewer: Actor;
  let outsider: Actor;

  async function writeEvent(): Promise<string> {
    const aggregateId = randomUUID();

    await withTransaction(getDatabase(), (transaction) =>
      writeOutboxEvents(transaction, [
        {
          organizationId: fixture.organizationId,
          locationId: fixture.locationA,
          eventType: "order.closed",
          aggregateType: "order",
          aggregateId,
          payload: { orderId: aggregateId, marker: PAYLOAD_MARKER },
          occurredAt: new Date(),
        },
      ]),
    );

    const [row] = await getDatabase()
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, aggregateId));

    return row!.id;
  }

  const rowOf = async (id: string) =>
    (await getDatabase().select().from(outboxEvents).where(eq(outboxEvents.id, id)))[0]!;

  beforeAll(async () => {
    // Publish anything earlier files left, so counts below are this file's own.
    await processOutboxBatch(getDatabase(), () => {}, { limit: 10_000, now: new Date(Date.now() + 86_400_000) });

    fixture = await createOrganizationFixture(getDatabase());
    const ownerUser = await createUserFixture(getDatabase(), {
      assignments: [{ roleId: fixture.ownerRole, locationId: fixture.locationA }],
    });
    owner = await actorAt(getDatabase(), ownerUser.id, fixture.locationA, "admin.system.manage");

    const viewRole = await createRoleFixture(getDatabase(), fixture.organizationId, ["admin.system.view", "menu.view"]);
    const viewerUser = await createUserFixture(getDatabase(), { assignments: [{ roleId: viewRole, locationId: fixture.locationA }] });
    viewer = await actorAt(getDatabase(), viewerUser.id, fixture.locationA);

    const serverUser = await createUserFixture(getDatabase(), {
      assignments: [{ roleId: fixture.serverRole, locationId: fixture.locationA }],
    });
    outsider = await actorAt(getDatabase(), serverUser.id, fixture.locationA);
  });

  afterAll(async () => {
    // Test cleanup only: lift the outbox guard for this transaction and remove this
    // organization's rows, whatever their state.
    await getDatabase().transaction(async (transaction) => {
      await transaction.execute("SET LOCAL session_replication_role = replica" as never);
      await transaction.delete(outboxEvents).where(eq(outboxEvents.organizationId, fixture.organizationId));
    });
    await closeDatabase();
  });

  it("backs a failing event off, dead-letters it at the maximum attempts, and never blocks later events", async () => {
    const failing = await writeEvent();
    const later = await writeEvent();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const publish = (event: { id: string }) => {
      if (event.id === failing) {
        throw new TypeError("realtime down");
      }
    };
    let now = new Date(Date.now() + 1000);

    try {
      // First batch: the later event publishes although the earlier one fails.
      await processOutboxBatch(getDatabase(), publish, { now, maxAttempts: 4 });
      expect((await rowOf(later)).publishedAt).not.toBeNull();

      let row = await rowOf(failing);

      expect(row).toMatchObject({ attempts: 1, lastError: "TypeError", failedAt: null, publishedAt: null });
      expect(row.nextAttemptAt).toEqual(new Date(now.getTime() + 1000));

      // Not claimed before its backoff ends.
      await processOutboxBatch(getDatabase(), publish, { now: new Date(now.getTime() + 999), maxAttempts: 4 });
      expect((await rowOf(failing)).attempts).toBe(1);

      for (const delay of [1000, 2000, 4000]) {
        now = new Date(now.getTime() + delay);
        await processOutboxBatch(getDatabase(), publish, { now, maxAttempts: 4 });
      }

      row = await rowOf(failing);
      expect(row.attempts).toBe(4);
      expect(row.failedAt).toEqual(now);
      expect(row.nextAttemptAt).toBeNull();

      // Dead-lettered: never claimed again, however late.
      await processOutboxBatch(getDatabase(), publish, { now: new Date(now.getTime() + 86_400_000), maxAttempts: 4 });
      expect((await rowOf(failing)).attempts).toBe(4);

      // Logged once, at error, with identifiers only.
      const deadLetterLines = errors.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes('"operation":"dead-letter"'));

      expect(deadLetterLines).toHaveLength(1);
      expect(deadLetterLines[0]).toContain(failing);
      expect(deadLetterLines[0]).not.toContain(PAYLOAD_MARKER);

      // A newer event still publishes.
      const newer = await writeEvent();

      await processOutboxBatch(getDatabase(), publish, { now: new Date(now.getTime() + 1), maxAttempts: 4 });
      expect((await rowOf(newer)).publishedAt).not.toBeNull();
    } finally {
      errors.mockRestore();
    }
  });

  it("shows counts and dead-lettered events without payloads, to admin.system.view only", async () => {
    const health = await getSystemHealth(getDatabase(), viewer);

    expect(health.deadLetteredCount).toBe(1);
    expect(health.deadLettered).toHaveLength(1);
    expect(health.deadLettered[0]).toMatchObject({ eventType: "order.closed", aggregateType: "order", attempts: 4, lastError: "TypeError" });
    expect(Object.keys(health.deadLettered[0]!)).not.toContain("payload");
    expect(JSON.stringify(health)).not.toContain(PAYLOAD_MARKER);

    expect(() => getSystemHealth(getDatabase(), outsider)).toThrow(AuthorizationError);
  });

  it("counts unpublished events and their age", async () => {
    const waiting = await writeEvent();
    const health = await getSystemHealth(getDatabase(), owner, new Date(Date.now() + 60_000));

    expect(health.unpublishedCount).toBe(1);
    expect(health.oldestUnpublishedAgeSeconds).toBeGreaterThanOrEqual(59);

    await processOutboxBatch(getDatabase(), () => {}, { now: new Date(Date.now() + 86_400_000), limit: 10_000 });
    expect((await rowOf(waiting)).publishedAt).not.toBeNull();
  });

  it("retries a dead-lettered event with admin.system.manage, audited without a payload", async () => {
    const [dead] = (await getSystemHealth(getDatabase(), owner)).deadLettered;

    await expect(retryDeadLetteredEvent(getDatabase(), viewer, dead!.id)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(retryDeadLetteredEvent(getDatabase(), outsider, dead!.id)).rejects.toBeInstanceOf(AuthorizationError);

    expect(await retryDeadLetteredEvent(getDatabase(), owner, dead!.id)).toEqual({ id: dead!.id, requeued: true });

    const row = await rowOf(dead!.id);

    expect(row).toMatchObject({ attempts: 0, failedAt: null, nextAttemptAt: null, publishedAt: null });

    const events = await getDatabase()
      .select()
      .from(auditEvents)
      .where(inArray(auditEvents.entityId, [dead!.id]));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "system.outbox-event-retried",
      category: "SYSTEM",
      entityType: "outbox_event",
      locationId: null,
      before: { eventType: "order.closed", aggregateType: "order", attempts: 4 },
      after: { attempts: 0 },
    });
    expect(JSON.stringify(events)).not.toContain(PAYLOAD_MARKER);

    // Requeued: it publishes on the next batch, and can't be retried again.
    await processOutboxBatch(getDatabase(), () => {}, { limit: 10_000 });
    expect((await rowOf(dead!.id)).publishedAt).not.toBeNull();
    await expect(retryDeadLetteredEvent(getDatabase(), owner, dead!.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses to retry another organization's event", async () => {
    const other = await createOrganizationFixture(getDatabase());
    const otherOwner = await createUserFixture(getDatabase(), {
      assignments: [{ roleId: other.ownerRole, locationId: other.locationA }],
    });
    const otherActor = await actorAt(getDatabase(), otherOwner.id, other.locationA, "admin.system.manage");
    const failing = await writeEvent();

    await processOutboxBatch(
      getDatabase(),
      (event) => {
        if (event.id === failing) {
          throw new Error("down");
        }
      },
      { maxAttempts: 1 },
    );

    expect((await rowOf(failing)).failedAt).not.toBeNull();
    await expect(retryDeadLetteredEvent(getDatabase(), otherActor, failing)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getSystemHealth(getDatabase(), otherActor)).deadLetteredCount).toBe(0);
  });
});
