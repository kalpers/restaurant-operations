import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { readConstraintName } from "@/db/helpers/database-errors";
import { managerLogCategories, managerLogEntries } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { addLogCategory, listLogCategories, updateLogCategory } from "@/modules/restaurant/services/manager-log-category-service";
import { addLogEntry } from "@/modules/restaurant/services/manager-log-service";
import { AppError, AuthorizationError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import { createSchedulingScenario, type SchedulingScenario } from "../../fixtures/scheduling-fixtures";

// Phase 33 policies 17–18: configurable manager log categories, organization-wide, never
// deleted, with the six defaults on first use.

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

describe("manager log categories (Phase 33)", () => {
  let scenario: SchedulingScenario;
  let generalManager: Actor;
  let manager: Actor;
  let managerAtB: Actor;

  beforeEach(async () => {
    scenario = await createSchedulingScenario(database());
    generalManager = await actorWith(database(), scenario, ["manager-log.view", "manager-log.write", "manager-log.categories"]);
    manager = await actorWith(database(), scenario, ["manager-log.view", "manager-log.write"]);
    managerAtB = await actorWith(database(), scenario, ["manager-log.view", "manager-log.write"], scenario.locationB);
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  const add = (actor: Actor, category: string) =>
    addLogEntry(database(), actor, {
      idempotencyKey: `log-${randomUUID()}`,
      dateChoice: "CURRENT",
      category,
      body: "Health inspector visited; all passed.",
      correctsEntryId: null,
    });

  it("starts with the six defaults, for every location of the organization", async () => {
    const categories = await listLogCategories(database(), manager);

    expect(categories.map((category) => category.code)).toEqual(["SERVICE", "INCIDENT", "MAINTENANCE", "STAFFING", "GUEST", "OTHER"]);
    expect(categories.every((category) => category.active)).toBe(true);
    expect((await listLogCategories(database(), managerAtB)).map((category) => category.id)).toEqual(categories.map((category) => category.id));
  });

  it("adds a category that every location can use, and refuses a duplicate code", async () => {
    const added = await addLogCategory(database(), generalManager, { name: "Health inspection" });

    expect(added).toMatchObject({ code: "HEALTH_INSPECTION", name: "Health inspection", active: true, sortOrder: 70 });
    expect(await codeOf(add(managerAtB, "HEALTH_INSPECTION"))).toBeUndefined();
    expect(await codeOf(addLogCategory(database(), generalManager, { name: "Health  inspection" }))).toBe("CATEGORY_CODE_IN_USE");
    expect(await codeOf(addLogCategory(database(), generalManager, { name: "x", code: "bad code" }))).toBe("INVALID_CATEGORY_CODE");
  });

  it("deactivated categories stay on old entries but can't be chosen, and can come back", async () => {
    const added = await addLogCategory(database(), generalManager, { name: "Deliveries" });
    const old = await add(manager, added.code);
    const off = await updateLogCategory(database(), generalManager, added.id, {
      name: "Deliveries (old)",
      sortOrder: 80,
      active: false,
      expectedVersion: added.version,
    });

    expect(await codeOf(add(manager, added.code))).toBe("CATEGORY_NOT_AVAILABLE");
    expect(await codeOf(add(manager, "NOT_A_CATEGORY"))).toBe("CATEGORY_NOT_AVAILABLE");
    expect((await database().select().from(managerLogEntries).where(eq(managerLogEntries.id, old.id)))[0]!.category).toBe(added.code);

    await updateLogCategory(database(), generalManager, added.id, { name: "Deliveries", sortOrder: 80, active: true, expectedVersion: off.version });
    expect(await codeOf(add(manager, added.code))).toBeUndefined();
  });

  it("refuses a stale version and deactivating the last active category", async () => {
    const categories = await listLogCategories(database(), generalManager);
    const [first, ...rest] = categories;

    await expect(
      updateLogCategory(database(), generalManager, first!.id, { name: first!.name, sortOrder: 1, active: true, expectedVersion: first!.version + 5 }),
    ).rejects.toBeInstanceOf(ConcurrencyError);

    for (const category of rest) {
      await updateLogCategory(database(), generalManager, category.id, {
        name: category.name,
        sortOrder: category.sortOrder,
        active: false,
        expectedVersion: category.version,
      });
    }

    expect(
      await codeOf(updateLogCategory(database(), generalManager, first!.id, { name: first!.name, sortOrder: 1, active: false, expectedVersion: first!.version })),
    ).toBe("LAST_ACTIVE_CATEGORY");
  });

  it("needs manager-log.categories to change them", async () => {
    await expect(addLogCategory(database(), manager, { name: "Nope" })).rejects.toBeInstanceOf(AuthorizationError);

    const [first] = await listLogCategories(database(), manager);

    await expect(
      updateLogCategory(database(), manager, first!.id, { name: "x", sortOrder: 1, active: true, expectedVersion: first!.version }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("can't be deleted, nor its code changed, in the database", async () => {
    const [first] = await listLogCategories(database(), manager);

    expect(await codeOf(database().delete(managerLogCategories).where(eq(managerLogCategories.id, first!.id)))).toBe(
      "DB:manager_log_categories_not_deleted",
    );
    expect(await codeOf(database().execute(sql`UPDATE manager_log_categories SET code = 'RENAMED' WHERE id = ${first!.id}`))).toBe(
      "DB:manager_log_categories_code_fixed",
    );
  });
});
