import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, checklistRunItems, checklistRuns, checklistTemplates } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { readLocationClock } from "@/modules/restaurant/services/access";
import {
  completeChecklistRun,
  createChecklistTemplate,
  getChecklistRun,
  listChecklistHistory,
  listChecklistsToday,
  setChecklistItem,
  signOffChecklistRun,
  startChecklistRun,
  updateChecklistTemplate,
  type TemplateInput,
} from "@/modules/restaurant/services/checklist-service";
import { AppError } from "@/shared/errors/app-error";
import { addDays } from "@/shared/time/zoned-time";

import { actorWith, clearEmployeeData, createPositionFixture } from "../../fixtures/employee-fixtures";
import { createLinkedEmployee, createSchedulingScenario, type SchedulingScenario } from "../../fixtures/scheduling-fixtures";

const database = () => getDatabase();

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) {
      return error.code;
    }

    const cause = error as { constraint_name?: string; cause?: { constraint_name?: string }; message: string };

    return cause.constraint_name ?? cause.cause?.constraint_name ?? cause.message;
  }

  return undefined;
}

describe("checklists (Phase 36 part 1)", () => {
  let scenario: SchedulingScenario;
  let manager: Actor;
  let otherManager: Actor;
  let server: Actor;
  let serverEmployee: string;
  let otherServer: Actor;
  let cook: Actor;
  let cookPosition: string;
  let today: string;

  beforeEach(async () => {
    await clearEmployeeData(database());
    scenario = await createSchedulingScenario(database());
    const managerPermissions = ["checklists.view", "checklists.complete", "checklists.manage"] as const;
    manager = await actorWith(database(), scenario, [...managerPermissions]);
    otherManager = await actorWith(database(), scenario, [...managerPermissions]);
    cookPosition = await createPositionFixture(database(), scenario.organizationId, `COOK_${Date.now()}`);
    ({ actor: server, employeeId: serverEmployee } = await createLinkedEmployee(database(), scenario, ["checklists.view", "checklists.complete"], {
      positionId: scenario.server,
    }));
    ({ actor: otherServer } = await createLinkedEmployee(database(), scenario, ["checklists.view", "checklists.complete"], {
      positionId: scenario.server,
    }));
    ({ actor: cook } = await createLinkedEmployee(database(), scenario, ["checklists.view", "checklists.complete"], { positionId: cookPosition }));
    today = (await readLocationClock(database(), scenario.locationA, new Date())).businessDate;
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  function template(input: Partial<TemplateInput> = {}) {
    return createChecklistTemplate(database(), manager, {
      name: "Opening",
      kind: "OPENING",
      requiresSignOff: false,
      positionIds: [],
      items: [
        { text: "Unlock doors", required: true },
        { text: "Check walk-in", required: true },
        { text: "Polish glasses", required: false },
      ],
      ...input,
    });
  }

  it("copies the template's active items when started, and edits never change a started run", async () => {
    const created = await template();
    const run = await startChecklistRun(database(), server, { templateId: created.id });

    expect(run.items.map((item) => item.text)).toEqual(["Unlock doors", "Check walk-in", "Polish glasses"]);
    expect(run).toMatchObject({ businessDate: today, status: "IN_PROGRESS", templateName: "Opening", workable: true });

    await updateChecklistTemplate(database(), manager, created.id, {
      name: "Opening (new)",
      kind: "OPENING",
      requiresSignOff: false,
      positionIds: [],
      active: true,
      expectedVersion: created.version,
      items: [{ id: created.items[0]!.id, text: "Unlock both doors", required: true }],
    });

    const again = await getChecklistRun(database(), server, run.id);

    expect(again.templateName).toBe("Opening");
    expect(again.items.map((item) => item.text)).toEqual(["Unlock doors", "Check walk-in", "Polish glasses"]);
  });

  it("returns the same run when started twice, including at the same time", async () => {
    const created = await template();
    const [a, b] = await Promise.all([
      startChecklistRun(database(), server, { templateId: created.id }),
      startChecklistRun(database(), otherServer, { templateId: created.id }),
    ]);

    expect(a.id).toBe(b.id);
    expect((await database().select().from(checklistRuns)).length).toBe(1);
  });

  it("gives each employee their own side-work run", async () => {
    const created = await template({ name: "Server side work", kind: "SIDE_WORK", positionIds: [scenario.server] });
    const mine = await startChecklistRun(database(), server, { templateId: created.id });
    const theirs = await startChecklistRun(database(), otherServer, { templateId: created.id });

    expect(mine.id).not.toBe(theirs.id);
    expect(mine.employeeId).toBe(serverEmployee);

    // Someone else's side work isn't theirs to tick.
    expect(
      await codeOf(setChecklistItem(database(), otherServer, mine.items[0]!.id, { state: "DONE", expectedVersion: 1 })),
    ).toBe("PERMISSION_DENIED");

    // A user with no employee record can't start side work for themselves.
    expect(await codeOf(startChecklistRun(database(), manager, { templateId: created.id }))).toBe("NO_EMPLOYEE_RECORD");

    // Managers see everyone's side work; servers see their own.
    expect((await listChecklistsToday(database(), manager)).sideWork).toHaveLength(2);
    expect((await listChecklistsToday(database(), server)).entries[0]!.run!.id).toBe(mine.id);
  });

  it("shows templates for everyone and for the reader's positions", async () => {
    await template({ name: "Everyone" });
    await template({ name: "Line", positionIds: [cookPosition] });

    expect((await listChecklistsToday(database(), server)).entries.map((entry) => entry.template.name)).toEqual(["Everyone"]);
    expect((await listChecklistsToday(database(), cook)).entries.map((entry) => entry.template.name).sort()).toEqual(["Everyone", "Line"]);
    expect((await listChecklistsToday(database(), manager)).entries).toHaveLength(2);
  });

  it("ticks items with their own versions, so two people working one list don't conflict", async () => {
    const run = await startChecklistRun(database(), server, { templateId: (await template()).id });
    const [first, second] = run.items;

    await Promise.all([
      setChecklistItem(database(), server, first!.id, { state: "DONE", expectedVersion: first!.version }),
      setChecklistItem(database(), otherServer, second!.id, { state: "DONE", expectedVersion: second!.version }),
    ]);

    const after = await getChecklistRun(database(), server, run.id);

    expect(after.items.slice(0, 2).map((item) => item.state)).toEqual(["DONE", "DONE"]);

    // A stale version is a conflict.
    expect(await codeOf(setChecklistItem(database(), server, first!.id, { state: "OPEN", expectedVersion: first!.version }))).toBe(
      "CONCURRENCY_CONFLICT",
    );
  });

  it("lets only the person who ticked an item, or a manager, undo it", async () => {
    const run = await startChecklistRun(database(), server, { templateId: (await template()).id });
    const item = run.items[0]!;
    const ticked = (await setChecklistItem(database(), server, item.id, { state: "DONE", expectedVersion: item.version })).items[0]!;

    expect(ticked.actedByName).not.toBeNull();
    expect(await codeOf(setChecklistItem(database(), otherServer, item.id, { state: "OPEN", expectedVersion: ticked.version }))).toBe(
      "TICKED_BY_SOMEONE_ELSE",
    );

    const undone = (await setChecklistItem(database(), manager, item.id, { state: "OPEN", expectedVersion: ticked.version })).items[0]!;

    expect(undone).toMatchObject({ state: "OPEN", actedByName: null, actedAt: null });
  });

  it("needs a reason to skip, and refuses card numbers in notes", async () => {
    const run = await startChecklistRun(database(), server, { templateId: (await template()).id });
    const item = run.items[0]!;

    expect(await codeOf(setChecklistItem(database(), server, item.id, { state: "SKIPPED", expectedVersion: 1 }))).toBe("SKIP_REASON_REQUIRED");
    expect(
      await codeOf(setChecklistItem(database(), server, item.id, { state: "DONE", note: "4111111111111111", expectedVersion: 1 })),
    ).toBe("CARD_DATA_REFUSED");

    const skipped = (await setChecklistItem(database(), server, item.id, { state: "SKIPPED", skipReason: "Key missing", expectedVersion: 1 }))
      .items[0]!;

    expect(skipped).toMatchObject({ state: "SKIPPED", skipReason: "Key missing" });
  });

  it("refuses to complete while a required item is open, then freezes the run", async () => {
    const run = await startChecklistRun(database(), server, { templateId: (await template()).id });

    expect(await codeOf(completeChecklistRun(database(), server, run.id, { expectedVersion: run.version }))).toBe("CHECKLIST_INCOMPLETE");

    for (const item of run.items.filter((entry) => entry.required)) {
      await setChecklistItem(database(), server, item.id, { state: "DONE", expectedVersion: item.version });
    }

    const completed = await completeChecklistRun(database(), server, run.id, { expectedVersion: run.version });

    expect(completed).toMatchObject({ status: "COMPLETED", workable: false });
    expect(await codeOf(setChecklistItem(database(), server, run.items[2]!.id, { state: "DONE", expectedVersion: 1 }))).toBe(
      "CHECKLIST_COMPLETED",
    );

    const [audit] = await database().select().from(auditEvents).where(eq(auditEvents.action, "restaurant.checklist-completed"));

    expect(audit?.details).toMatchObject({ templateName: "Opening", itemsDone: 2, itemsSkipped: 0 });

    // The database refuses changes to a completed run's items, and deletes.
    expect(
      await codeOf(database().update(checklistRunItems).set({ state: "OPEN", actedAt: null, actedByUserId: null }).where(eq(checklistRunItems.runId, run.id))),
    ).toBe("checklist_run_items_completed_frozen");
    expect(await codeOf(database().delete(checklistRuns).where(eq(checklistRuns.id, run.id)))).toBe("checklist_runs_no_delete");
    expect(await codeOf(database().delete(checklistTemplates))).toBe("checklist_config_no_delete");
    expect(
      await codeOf(database().update(checklistRuns).set({ status: "OPEN", completedAt: null, completedByUserId: null }).where(eq(checklistRuns.id, run.id))),
    ).toBe("checklist_runs_completed_frozen");
  });

  it("is signed off once, by a manager other than the one who completed it", async () => {
    const created = await template({ name: "Closing", kind: "CLOSING", requiresSignOff: true, items: [{ text: "Lock up", required: true }] });
    const run = await startChecklistRun(database(), manager, { templateId: created.id });

    await setChecklistItem(database(), manager, run.items[0]!.id, { state: "DONE", expectedVersion: 1 });

    const completed = await completeChecklistRun(database(), manager, run.id, { expectedVersion: run.version });

    expect(completed.status).toBe("AWAITING_SIGN_OFF");
    expect(completed.canSignOff).toBe(false);
    expect(await codeOf(signOffChecklistRun(database(), manager, run.id, { expectedVersion: completed.version }))).toBe("SIGN_OFF_BY_ANOTHER");
    expect(await codeOf(signOffChecklistRun(database(), server, run.id, { expectedVersion: completed.version }))).toBe("PERMISSION_DENIED");

    const signed = await signOffChecklistRun(database(), otherManager, run.id, { expectedVersion: completed.version });

    expect(signed).toMatchObject({ status: "SIGNED_OFF", signedOffByName: null });
    expect(await codeOf(signOffChecklistRun(database(), otherManager, run.id, { expectedVersion: signed.version }))).toBe("ALREADY_SIGNED_OFF");
  });

  it("works out missed checklists on read", async () => {
    const opening = await template();
    const closing = await template({ name: "Closing", kind: "CLOSING" });
    const run = await startChecklistRun(database(), server, { templateId: opening.id });

    // Move both templates' start and the run back two days, as if they had been made then.
    const twoDaysAgo = addDays(today, -2);

    await database()
      .update(checklistTemplates)
      .set({ createdAt: sql`now() - interval '2 days'` })
      .where(eq(checklistTemplates.locationId, scenario.locationA));
    await database().execute(sql`ALTER TABLE checklist_runs DISABLE TRIGGER checklist_runs_guard_trigger`);
    await database().update(checklistRuns).set({ businessDate: twoDaysAgo }).where(eq(checklistRuns.id, run.id));
    await database().execute(sql`ALTER TABLE checklist_runs ENABLE TRIGGER checklist_runs_guard_trigger`);

    const { rows } = await listChecklistHistory(database(), manager, { from: twoDaysAgo, to: today });
    const statusOf = (date: string, name: string) => rows.find((row) => row.businessDate === date && row.templateName === name)?.status;

    expect(statusOf(twoDaysAgo, "Opening")).toBe("NOT_COMPLETED");
    expect(statusOf(twoDaysAgo, "Closing")).toBe("NOT_STARTED");
    expect(statusOf(today, "Opening")).toBe("NOT_STARTED");
    expect(closing.kind).toBe("CLOSING");

    // An earlier day's run is read-only.
    expect(await codeOf(setChecklistItem(database(), server, run.items[0]!.id, { state: "DONE", expectedVersion: 1 }))).toBe(
      "CHECKLIST_READ_ONLY",
    );

    expect(await codeOf(listChecklistHistory(database(), manager, { from: addDays(today, -40), to: today }))).toBe("RANGE_TOO_LONG");
  });

  it("checks permissions in each service", async () => {
    const viewer = await actorWith(database(), scenario, ["checklists.view"]);
    const created = await template();

    expect(await codeOf(startChecklistRun(database(), viewer, { templateId: created.id }))).toBe("PERMISSION_DENIED");
    expect(
      await codeOf(
        createChecklistTemplate(database(), server, {
          name: "X",
          kind: "OTHER",
          requiresSignOff: false,
          positionIds: [],
          items: [{ text: "A", required: true }],
        }),
      ),
    ).toBe("PERMISSION_DENIED");

    // A template at another location isn't found here.
    const atB = await actorWith(database(), scenario, ["checklists.view", "checklists.complete"], scenario.locationB);

    expect(await codeOf(startChecklistRun(database(), atB, { templateId: created.id }))).toBe("NOT_FOUND");
  });

  it("refuses a template with no active items", async () => {
    expect(await codeOf(template({ items: [{ text: "Gone", required: true, active: false }] }))).toBe("CHECKLIST_EMPTY");
  });
});
