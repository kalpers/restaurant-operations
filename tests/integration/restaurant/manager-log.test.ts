import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { readConstraintName } from "@/db/helpers/database-errors";
import { auditEvents, idempotencyRecords, managerLogEntries } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { readLocationClock } from "@/modules/restaurant/services/access";
import {
  addLogEntry,
  listLogEntries,
  redactLogEntry,
  type AddLogEntryInput,
} from "@/modules/restaurant/services/manager-log-service";
import { AppError } from "@/shared/errors/app-error";
import { addDays } from "@/shared/time/zoned-time";

import { clearEmployeeData } from "../../fixtures/employee-fixtures";
import { createLinkedEmployee, createSchedulingScenario, type SchedulingScenario } from "../../fixtures/scheduling-fixtures";
import { actorWith } from "../../fixtures/employee-fixtures";

const database = () => getDatabase();

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) {
      return error.code;
    }

    return `DB:${readConstraintName(error) ?? (error as Error).message}`;
  }

  return undefined;
}

const LOG_PERMISSIONS = ["manager-log.view", "manager-log.write"] as const;

describe("manager log (Phase 32)", () => {
  let scenario: SchedulingScenario;
  let manager: Actor;
  let managerEmployeeId: string;
  let generalManager: Actor;
  let today: string;

  beforeEach(async () => {
    scenario = await createSchedulingScenario(database());
    ({ actor: manager, employeeId: managerEmployeeId } = await createLinkedEmployee(database(), scenario, [...LOG_PERMISSIONS]));
    generalManager = await actorWith(database(), scenario, [...LOG_PERMISSIONS, "manager-log.redact"]);
    today = (await readLocationClock(database(), scenario.locationA, new Date())).businessDate;
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  function add(actor: Actor, input: Partial<AddLogEntryInput> = {}) {
    return addLogEntry(database(), actor, {
      idempotencyKey: `log-${randomUUID()}`,
      dateChoice: "CURRENT",
      category: "SERVICE",
      body: "Walk-in door sticking; called the repair company.",
      correctsEntryId: null,
      ...input,
    });
  }

  const rowOf = async (id: string) => (await database().select().from(managerLogEntries).where(eq(managerLogEntries.id, id)))[0]!;
  const day = (actor: Actor, date = today) => listLogEntries(database(), actor, { from: date, to: date });

  it("stores the business date, author, employee and a LOG number", async () => {
    const added = await add(manager);
    const row = await rowOf(added.id);

    expect(added.entryNumber).toMatch(/^LOG-\d{6}$/);
    expect(added.businessDate).toBe(today);
    expect(row).toMatchObject({
      locationId: scenario.locationA,
      authorUserId: manager.userId,
      authorEmployeeId: managerEmployeeId,
      category: "SERVICE",
      redactedAt: null,
    });

    const [view] = (await day(manager)).entries;

    expect(view).toMatchObject({ entryNumber: added.entryNumber, authorName: expect.any(String), correctedBy: [], redaction: null });
  });

  it("gives the previous business date when chosen, and numbers entries in order", async () => {
    const first = await add(manager);
    const previous = await add(manager, { dateChoice: "PREVIOUS" });

    expect(previous.businessDate).toBe(addDays(today, -1));
    expect(Number(previous.entryNumber.slice(4))).toBe(Number(first.entryNumber.slice(4)) + 1);
    expect((await day(manager, addDays(today, -1))).entries.map((entry) => entry.id)).toEqual([previous.id]);
  });

  it("adds one entry for a retried key, and keeps no body in the idempotency record", async () => {
    const key = `log-${randomUUID()}`;
    const first = await add(manager, { idempotencyKey: key });
    const retry = await add(manager, { idempotencyKey: key });

    expect(retry).toMatchObject({ id: first.id, replayed: true });
    expect((await day(manager)).entries).toHaveLength(1);

    const [record] = await database().select().from(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, key));

    expect(JSON.stringify(record!.response)).not.toContain("Walk-in");
    expect(await codeOf(add(manager, { idempotencyKey: key, body: "Something else" }))).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("links a correction to the original and marks the original", async () => {
    const original = await add(manager);
    const correction = await add(manager, { correctsEntryId: original.id, body: "Correction: it was the reach-in door." });
    const entries = (await day(manager)).entries;

    expect(entries.find((entry) => entry.id === original.id)!.correctedBy).toEqual([correction.entryNumber]);
    expect(entries.find((entry) => entry.id === correction.id)!.corrects).toEqual({
      id: original.id,
      entryNumber: original.entryNumber,
    });
  });

  it("refuses a correction of an entry at another location", async () => {
    const elsewhere = await actorWith(database(), scenario, [...LOG_PERMISSIONS], scenario.locationB);
    const original = await add(elsewhere);

    expect(await codeOf(add(manager, { correctsEntryId: original.id }))).toBe("NOT_FOUND");

    // The database refuses it too.
    const code = await codeOf(
      database().insert(managerLogEntries).values({
        organizationId: scenario.organizationId,
        locationId: scenario.locationA,
        entryNumber: 999_001,
        businessDate: today,
        category: "OTHER",
        body: "x",
        authorUserId: manager.userId,
        correctsEntryId: original.id,
      }),
    );

    expect(code).toBe("DB:manager_log_entries_correction_valid");
  });

  it("refuses an update or delete made directly in the database", async () => {
    const added = await add(manager);

    expect(await codeOf(database().update(managerLogEntries).set({ body: "Rewritten" }).where(eq(managerLogEntries.id, added.id)))).toBe(
      "DB:manager_log_entries_append_only",
    );
    expect(await codeOf(database().delete(managerLogEntries).where(eq(managerLogEntries.id, added.id)))).toBe(
      "DB:manager_log_entries_append_only",
    );
    // A redaction that also changes the category is refused.
    expect(
      await codeOf(
        database()
          .update(managerLogEntries)
          .set({ body: "", redactedAt: new Date(), redactedByUserId: manager.userId, redactionReason: "x", category: "OTHER" })
          .where(eq(managerLogEntries.id, added.id)),
      ),
    ).toBe("DB:manager_log_entries_append_only");
    expect((await rowOf(added.id)).body).toContain("Walk-in");
  });

  it("redacts once, keeps the entry's place, and audits without the body", async () => {
    const added = await add(manager, { category: "GUEST", body: "Guest's phone is in the reservation; she has a nut allergy." });
    const view = await redactLogEntry(database(), generalManager, added.id, { reason: "Health detail about a guest" });

    expect(view).toMatchObject({ entryNumber: added.entryNumber, category: "GUEST", body: "" });
    expect(view.redaction).toMatchObject({ reason: "Health detail about a guest" });

    const row = await rowOf(added.id);

    expect(row).toMatchObject({ body: "", redactedByUserId: generalManager.userId, businessDate: today, authorUserId: manager.userId });

    const audits = await database().select().from(auditEvents).where(eq(auditEvents.entityId, added.id));

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "restaurant.manager-log-redacted", category: "ORGANIZATION", locationId: scenario.locationA });
    expect(audits[0]!.details).toEqual({ entryNumber: added.entryNumber, businessDate: today, category: "GUEST", reasonLength: 27 });
    expect(JSON.stringify(audits[0])).not.toContain("allergy");

    expect(await codeOf(redactLogEntry(database(), generalManager, added.id, { reason: "Again" }))).toBe("ALREADY_REDACTED");
    expect(
      await codeOf(
        database()
          .update(managerLogEntries)
          .set({ redactionReason: "Changed" })
          .where(eq(managerLogEntries.id, added.id)),
      ),
    ).toBe("DB:manager_log_entries_append_only");
  });

  it("enforces each permission", async () => {
    const reader = await actorWith(database(), scenario, ["manager-log.view"]);
    const staff = await actorWith(database(), scenario, ["pre-shift.view"]);
    const added = await add(manager);

    expect((await day(reader)).entries).toHaveLength(1);
    expect(await codeOf(add(reader))).toBe("PERMISSION_DENIED");
    expect(await codeOf(day(staff))).toBe("PERMISSION_DENIED");
    expect(await codeOf(redactLogEntry(database(), manager, added.id, { reason: "No" }))).toBe("PERMISSION_DENIED");
  });

  it("keeps each location's log to itself", async () => {
    const elsewhere = await actorWith(database(), scenario, [...LOG_PERMISSIONS, "manager-log.redact"], scenario.locationB);
    const added = await add(manager);

    expect((await day(elsewhere)).entries).toHaveLength(0);
    expect(await codeOf(redactLogEntry(database(), elsewhere, added.id, { reason: "Wrong place" }))).toBe("NOT_FOUND");
  });

  it("searches text and category across up to 31 days, with wildcards taken literally", async () => {
    await add(manager, { body: "Fryer 2 down at 7pm", category: "MAINTENANCE" });
    await add(manager, { body: "Took 50% off a steak", category: "GUEST", dateChoice: "PREVIOUS" });
    await add(manager, { body: "Short one server", category: "STAFFING" });

    const search = (text: string | null, category: "GUEST" | "MAINTENANCE" | null = null) =>
      listLogEntries(database(), manager, { from: addDays(today, -1), to: today, text, category });

    expect((await search("fryer")).entries.map((entry) => entry.body)).toEqual(["Fryer 2 down at 7pm"]);
    expect((await search("50%")).entries).toHaveLength(1);
    expect((await search("%")).entries).toHaveLength(1);
    expect((await search(null, "GUEST")).entries.map((entry) => entry.businessDate)).toEqual([addDays(today, -1)]);
    expect((await search(null)).entries.map((entry) => entry.businessDate)).toEqual([today, today, addDays(today, -1)]);
    expect(await codeOf(listLogEntries(database(), manager, { from: addDays(today, -31), to: today }))).toBe("RANGE_TOO_LONG");
  });

  it("refuses card numbers in an entry", async () => {
    expect(await codeOf(add(manager, { body: "Guest left card 4111111111111111 at the bar" }))).toBe("CARD_DATA_REFUSED");
    expect(
      await database()
        .select({ total: sql<number>`count(*)::int` })
        .from(managerLogEntries)
        .where(eq(managerLogEntries.locationId, scenario.locationA)),
    ).toEqual([{ total: 0 }]);
  });
});
