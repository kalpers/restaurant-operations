import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";

import type { Database } from "@/db";
import { assertVersionMatched, nextVersion } from "@/db/helpers/versioning";
import {
  checklistRunItems,
  checklistRuns,
  checklistTemplateItems,
  checklistTemplatePositions,
  checklistTemplates,
  type ChecklistItemState,
  type ChecklistKind,
  type ChecklistRunStatus,
} from "@/db/schema";
import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { findHeldPositionIds, findTargetPositions } from "@/modules/employees/queries/briefing-positions";
import { findDisplayNamesByUser, findEmployeeDisplayNames } from "@/modules/employees/queries/employee-display-names";
import { findLinkedEmployeeId } from "@/modules/employees/queries/scheduling-facts";
import { AuthorizationError, BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";

import {
  assertCanComplete,
  assertCanSignOff,
  assertRunWorkable,
  canChangeTick,
  canWorkRun,
  datesDescending,
  displayStatus,
  isTemplateRelevant,
  MAX_CHECKLIST_HISTORY_DAYS,
  skipReasonOf,
  type DisplayStatus,
} from "../rules/checklist-rules";
import { assertNoCardNumber, assertSearchRange } from "../rules/manager-log-rules";
import { actorHolds, assertPermission, readLocationClock } from "./access";

// Phase 36 part 1 (policy 5): opening, closing and side-work checklists. Templates are a
// location's configuration. A run copies the template's active items when started, for the
// current business date only; each item is ticked with its own version, and a completed run is
// frozen (migration 0082). Missed checklists are worked out on read; nothing is notified.

type TemplateRow = typeof checklistTemplates.$inferSelect;
type RunRow = typeof checklistRuns.$inferSelect;
type RunItemRow = typeof checklistRunItems.$inferSelect;

export type ChecklistTemplateView = {
  id: string;
  name: string;
  kind: ChecklistKind;
  requiresSignOff: boolean;
  active: boolean;
  version: number;
  positions: { id: string; name: string }[];
  items: { id: string; text: string; required: boolean; sortOrder: number; active: boolean }[];
};

export type ChecklistRunItemView = {
  id: string;
  text: string;
  required: boolean;
  state: ChecklistItemState;
  actedByName: string | null;
  actedAt: string | null;
  skipReason: string | null;
  note: string | null;
  version: number;
  /** Whether the reader may change this item's tick now. */
  changeable: boolean;
};

export type ChecklistRunView = {
  id: string;
  templateId: string;
  templateName: string;
  kind: ChecklistKind;
  businessDate: string;
  employeeId: string | null;
  employeeName: string | null;
  status: DisplayStatus;
  requiresSignOff: boolean;
  startedByName: string | null;
  startedAt: string;
  completedByName: string | null;
  completedAt: string | null;
  signedOffByName: string | null;
  signedOffAt: string | null;
  version: number;
  /** Whether the reader may tick items and complete it now. */
  workable: boolean;
  canSignOff: boolean;
  items: ChecklistRunItemView[];
};

const isManager = (actor: Actor) => actorHolds(actor, "checklists.manage");

async function today(executor: DatabaseExecutor, actor: Actor): Promise<string> {
  return (await readLocationClock(executor, actor.locationId, new Date())).businessDate;
}

async function positionIdsOf(executor: DatabaseExecutor, templateIds: readonly string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();

  if (templateIds.length === 0) {
    return result;
  }

  const rows = await executor
    .select({ templateId: checklistTemplatePositions.templateId, positionId: checklistTemplatePositions.positionId })
    .from(checklistTemplatePositions)
    .where(inArray(checklistTemplatePositions.templateId, [...templateIds]));

  for (const row of rows) {
    result.set(row.templateId, [...(result.get(row.templateId) ?? []), row.positionId]);
  }

  return result;
}

async function templateViews(executor: DatabaseExecutor, actor: Actor, rows: readonly TemplateRow[]): Promise<ChecklistTemplateView[]> {
  const ids = rows.map((row) => row.id);
  const [positions, items] = await Promise.all([
    positionIdsOf(executor, ids),
    ids.length === 0
      ? Promise.resolve([])
      : executor
          .select()
          .from(checklistTemplateItems)
          .where(inArray(checklistTemplateItems.templateId, ids))
          .orderBy(asc(checklistTemplateItems.sortOrder), asc(checklistTemplateItems.createdAt)),
  ]);
  const positionList = await findTargetPositions(executor, {
    organizationId: actor.organizationId,
    ids: [...new Set([...positions.values()].flat())],
  });
  const positionNames = new Map(positionList.map((position) => [position.id, position.name]));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind as ChecklistKind,
    requiresSignOff: row.requiresSignOff,
    active: row.active,
    version: row.version,
    positions: (positions.get(row.id) ?? [])
      .map((id) => ({ id, name: positionNames.get(id) ?? "Unknown position" }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    items: items
      .filter((item) => item.templateId === row.id)
      .map((item) => ({ id: item.id, text: item.text, required: item.required, sortOrder: item.sortOrder, active: item.active })),
  }));
}

async function templatesAt(executor: DatabaseExecutor, locationId: string, activeOnly: boolean): Promise<TemplateRow[]> {
  return executor
    .select()
    .from(checklistTemplates)
    .where(and(eq(checklistTemplates.locationId, locationId), ...(activeOnly ? [eq(checklistTemplates.active, true)] : [])))
    .orderBy(asc(checklistTemplates.kind), asc(checklistTemplates.name));
}

async function runViews(
  executor: DatabaseExecutor,
  actor: Actor,
  runs: readonly RunRow[],
  context: { today: string; actorEmployeeId: string | null; withItems: boolean },
): Promise<ChecklistRunView[]> {
  const items: RunItemRow[] =
    context.withItems && runs.length > 0
      ? await executor
          .select()
          .from(checklistRunItems)
          .where(inArray(checklistRunItems.runId, runs.map((run) => run.id)))
          .orderBy(asc(checklistRunItems.sortOrder))
      : [];
  const [names, employeeNames] = await Promise.all([
    findDisplayNamesByUser(executor, {
      organizationId: actor.organizationId,
      userIds: [
        ...runs.flatMap((run) => [run.startedByUserId, run.completedByUserId, run.signedOffByUserId]),
        ...items.map((item) => item.actedByUserId),
      ].filter((id): id is string => id !== null),
    }),
    findEmployeeDisplayNames(executor, {
      organizationId: actor.organizationId,
      employeeIds: runs.map((run) => run.employeeId).filter((id): id is string => id !== null),
    }),
  ]);
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  const manager = isManager(actor);

  return runs.map((run) => {
    const workable =
      run.status === "OPEN" &&
      run.businessDate === context.today &&
      actorHolds(actor, "checklists.complete") &&
      canWorkRun({ kind: run.kind as ChecklistKind, employeeId: run.employeeId }, context.actorEmployeeId, manager);

    return {
      id: run.id,
      templateId: run.templateId,
      templateName: run.templateNameSnapshot,
      kind: run.kind as ChecklistKind,
      businessDate: run.businessDate,
      employeeId: run.employeeId,
      employeeName: run.employeeId ? (employeeNames.get(run.employeeId) ?? null) : null,
      status: displayStatus({ ...run, status: run.status as ChecklistRunStatus }, context.today),
      requiresSignOff: run.requiresSignOff,
      startedByName: nameOf(run.startedByUserId),
      startedAt: run.startedAt.toISOString(),
      completedByName: nameOf(run.completedByUserId),
      completedAt: run.completedAt?.toISOString() ?? null,
      signedOffByName: nameOf(run.signedOffByUserId),
      signedOffAt: run.signedOffAt?.toISOString() ?? null,
      version: run.version,
      workable,
      canSignOff:
        manager && run.status === "COMPLETED" && run.requiresSignOff && !run.signedOffAt && run.completedByUserId !== actor.userId,
      items: items
        .filter((item) => item.runId === run.id)
        .map((item) => ({
          id: item.id,
          text: item.textSnapshot,
          required: item.required,
          state: item.state as ChecklistItemState,
          actedByName: nameOf(item.actedByUserId),
          actedAt: item.actedAt?.toISOString() ?? null,
          skipReason: item.skipReason,
          note: item.note,
          version: item.version,
          changeable:
            workable && canChangeTick({ state: item.state as ChecklistItemState, actedByUserId: item.actedByUserId }, actor.userId, manager),
        })),
    };
  });
}

async function linkedEmployee(executor: DatabaseExecutor, actor: Actor): Promise<string | null> {
  return findLinkedEmployeeId(executor, { userId: actor.userId, organizationId: actor.organizationId });
}

// ------------------------------------------------------------------------------ Templates

/** Every template at the location, inactive ones included, for managers. */
export async function listChecklistTemplates(executor: DatabaseExecutor, actor: Actor): Promise<ChecklistTemplateView[]> {
  assertPermission(actor, "checklists.manage");

  return templateViews(executor, actor, await templatesAt(executor, actor.locationId, false));
}

export type TemplateInput = {
  name: string;
  kind: ChecklistKind;
  requiresSignOff: boolean;
  positionIds: string[];
  /** In order. An item with an ID updates that item; one without is new; one left out is deactivated. */
  items: { id?: string | null; text: string; required: boolean; active?: boolean }[];
};

async function assertTargets(executor: DatabaseExecutor, actor: Actor, positionIds: readonly string[], kept: readonly string[] = []) {
  const unique = [...new Set(positionIds)];
  const found = new Map(
    (await findTargetPositions(executor, { organizationId: actor.organizationId, ids: unique })).map((position) => [position.id, position]),
  );

  for (const id of unique) {
    const position = found.get(id);

    if (!position) {
      throw new NotFoundError("position");
    }

    if (!position.active && !kept.includes(id)) {
      throw new BusinessRuleError("POSITION_INACTIVE", `${position.name} is no longer an active position.`);
    }
  }

  return unique;
}

async function writeTemplateParts(transaction: DatabaseTransaction, actor: Actor, templateId: string, input: TemplateInput, positionIds: readonly string[]) {
  await transaction.delete(checklistTemplatePositions).where(eq(checklistTemplatePositions.templateId, templateId));

  if (positionIds.length > 0) {
    await transaction
      .insert(checklistTemplatePositions)
      .values(positionIds.map((positionId) => ({ templateId, positionId, organizationId: actor.organizationId })));
  }

  const existing = await transaction.select().from(checklistTemplateItems).where(eq(checklistTemplateItems.templateId, templateId));
  const existingIds = new Set(existing.map((item) => item.id));
  const named = new Set<string>();

  for (const [index, item] of input.items.entries()) {
    const values = { text: item.text.trim(), required: item.required, sortOrder: (index + 1) * 10, active: item.active ?? true };

    if (item.id) {
      if (!existingIds.has(item.id) || named.has(item.id)) {
        throw new NotFoundError("checklist item");
      }

      named.add(item.id);
      await transaction.update(checklistTemplateItems).set(values).where(eq(checklistTemplateItems.id, item.id));
    } else {
      await transaction.insert(checklistTemplateItems).values({ ...values, templateId, organizationId: actor.organizationId });
    }
  }

  const leftOut = existing.filter((item) => !named.has(item.id) && item.active).map((item) => item.id);

  if (leftOut.length > 0) {
    await transaction.update(checklistTemplateItems).set({ active: false }).where(inArray(checklistTemplateItems.id, leftOut));
  }
}

function assertHasActiveItem(input: TemplateInput) {
  if (!input.items.some((item) => item.active ?? true)) {
    throw new BusinessRuleError("CHECKLIST_EMPTY", "A checklist needs at least one active item.");
  }
}

async function viewTemplate(executor: DatabaseExecutor, actor: Actor, templateId: string): Promise<ChecklistTemplateView> {
  const [row] = await executor.select().from(checklistTemplates).where(eq(checklistTemplates.id, templateId));
  const [view] = await templateViews(executor, actor, [row!]);

  return view!;
}

export async function createChecklistTemplate(database: Database, actor: Actor, input: TemplateInput): Promise<ChecklistTemplateView> {
  assertPermission(actor, "checklists.manage");
  assertHasActiveItem(input);

  return withTransaction(database, async (transaction) => {
    const positionIds = await assertTargets(transaction, actor, input.positionIds);
    const [row] = await transaction
      .insert(checklistTemplates)
      .values({
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        name: input.name.trim(),
        kind: input.kind,
        requiresSignOff: input.requiresSignOff,
        createdByUserId: actor.userId,
        updatedByUserId: actor.userId,
      })
      .returning({ id: checklistTemplates.id });

    await writeTemplateParts(transaction, actor, row!.id, input, positionIds);

    return viewTemplate(transaction, actor, row!.id);
  });
}

/** Edits never change a started run, which keeps its own copy (rule 4). */
export async function updateChecklistTemplate(
  database: Database,
  actor: Actor,
  templateId: string,
  input: TemplateInput & { active: boolean; expectedVersion: number },
): Promise<ChecklistTemplateView> {
  assertPermission(actor, "checklists.manage");
  assertHasActiveItem(input);

  return withTransaction(database, async (transaction) => {
    const [template] = await transaction
      .select()
      .from(checklistTemplates)
      .where(and(eq(checklistTemplates.id, templateId), eq(checklistTemplates.locationId, actor.locationId)))
      .for("update");

    if (!template) {
      throw new NotFoundError("checklist template");
    }

    const kept = (await positionIdsOf(transaction, [templateId])).get(templateId) ?? [];
    const positionIds = await assertTargets(transaction, actor, input.positionIds, kept);

    assertVersionMatched(
      await transaction
        .update(checklistTemplates)
        .set({
          name: input.name.trim(),
          kind: input.kind,
          requiresSignOff: input.requiresSignOff,
          active: input.active,
          updatedByUserId: actor.userId,
          version: nextVersion(checklistTemplates.version),
        })
        .where(and(eq(checklistTemplates.id, templateId), eq(checklistTemplates.version, input.expectedVersion)))
        .returning({ id: checklistTemplates.id }),
      { type: "checklist template", id: templateId },
    );
    await writeTemplateParts(transaction, actor, templateId, input, positionIds);

    return viewTemplate(transaction, actor, templateId);
  });
}

// ------------------------------------------------------------------------------ Today

export type ChecklistsToday = {
  businessDate: string;
  /** One entry per relevant template: its run today (the reader's own for side work), if started. */
  entries: { template: { id: string; name: string; kind: ChecklistKind; requiresSignOff: boolean }; run: ChecklistRunView | null }[];
  /** Managers: everyone's side-work runs today. */
  sideWork: ChecklistRunView[];
  /** Whether the reader can start side work (they have an employee record). */
  canStartSideWork: boolean;
};

/**
 * Policy 5: today's checklists for the reader. Templates for everyone or for a position the
 * reader holds here; managers see every active template and everyone's side work.
 */
export async function listChecklistsToday(executor: DatabaseExecutor, actor: Actor): Promise<ChecklistsToday> {
  assertPermission(actor, "checklists.view");

  const businessDate = await today(executor, actor);
  const manager = isManager(actor);
  const [templates, actorEmployeeId, held] = await Promise.all([
    templatesAt(executor, actor.locationId, true),
    linkedEmployee(executor, actor),
    findHeldPositionIds(executor, { userId: actor.userId, organizationId: actor.organizationId, locationId: actor.locationId }),
  ]);
  const positions = await positionIdsOf(executor, templates.map((template) => template.id));
  const relevant = manager ? templates : templates.filter((template) => isTemplateRelevant(positions.get(template.id) ?? [], held));
  const runs = await executor
    .select()
    .from(checklistRuns)
    .where(and(eq(checklistRuns.locationId, actor.locationId), eq(checklistRuns.businessDate, businessDate)));
  const views = await runViews(executor, actor, runs, { today: businessDate, actorEmployeeId, withItems: true });
  const own = (view: ChecklistRunView) =>
    view.kind !== "SIDE_WORK" || (actorEmployeeId !== null && view.employeeId === actorEmployeeId);

  return {
    businessDate,
    entries: relevant.map((template) => ({
      template: { id: template.id, name: template.name, kind: template.kind as ChecklistKind, requiresSignOff: template.requiresSignOff },
      run: views.find((view) => view.templateId === template.id && own(view)) ?? null,
    })),
    sideWork: manager ? views.filter((view) => view.kind === "SIDE_WORK") : [],
    canStartSideWork: actorEmployeeId !== null,
  };
}

/** One run, for its page. A side-work run is visible to its owner and managers. */
export async function getChecklistRun(executor: DatabaseExecutor, actor: Actor, runId: string): Promise<ChecklistRunView> {
  assertPermission(actor, "checklists.view");

  const [run] = await executor
    .select()
    .from(checklistRuns)
    .where(and(eq(checklistRuns.id, runId), eq(checklistRuns.locationId, actor.locationId)));

  if (!run) {
    throw new NotFoundError("checklist");
  }

  const [businessDate, actorEmployeeId] = await Promise.all([today(executor, actor), linkedEmployee(executor, actor)]);
  const [view] = await runViews(executor, actor, [run], { today: businessDate, actorEmployeeId, withItems: true });

  return view!;
}

// ------------------------------------------------------------------------------ Working a run

/**
 * Policy 5: starts today's run of a template, copying its active items. Starting one that
 * already exists returns it, so two people pressing Start at once get the same run. Side work
 * is the reader's own, or a named employee's for a manager.
 */
export async function startChecklistRun(
  database: Database,
  actor: Actor,
  input: { templateId: string; employeeId?: string | null },
): Promise<ChecklistRunView> {
  assertPermission(actor, "checklists.complete");

  const runId = await withTransaction(database, async (transaction) => {
    const [template] = await transaction
      .select()
      .from(checklistTemplates)
      .where(and(eq(checklistTemplates.id, input.templateId), eq(checklistTemplates.locationId, actor.locationId)))
      .for("share");

    if (!template) {
      throw new NotFoundError("checklist template");
    }

    if (!template.active) {
      throw new BusinessRuleError("CHECKLIST_TEMPLATE_INACTIVE", "This checklist is no longer in use.");
    }

    const businessDate = await today(transaction, actor);
    let employeeId: string | null = null;

    if (template.kind === "SIDE_WORK") {
      const own = await linkedEmployee(transaction, actor);

      if (input.employeeId && input.employeeId !== own) {
        if (!isManager(actor)) {
          throw new AuthorizationError();
        }

        employeeId = input.employeeId;
      } else if (own) {
        employeeId = own;
      } else {
        throw new BusinessRuleError("NO_EMPLOYEE_RECORD", "Side work is started by an employee for themselves.");
      }
    }

    const existing = async () =>
      (
        await transaction
          .select({ id: checklistRuns.id })
          .from(checklistRuns)
          .where(
            and(
              eq(checklistRuns.templateId, template.id),
              eq(checklistRuns.businessDate, businessDate),
              ...(employeeId ? [eq(checklistRuns.employeeId, employeeId)] : []),
            ),
          )
      ).find(Boolean)?.id;

    const already = await existing();

    if (already) {
      return already;
    }

    const items = await transaction
      .select()
      .from(checklistTemplateItems)
      .where(and(eq(checklistTemplateItems.templateId, template.id), eq(checklistTemplateItems.active, true)))
      .orderBy(asc(checklistTemplateItems.sortOrder), asc(checklistTemplateItems.createdAt));

    const [inserted] = await transaction
      .insert(checklistRuns)
      .values({
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        templateId: template.id,
        businessDate,
        kind: template.kind,
        templateNameSnapshot: template.name,
        requiresSignOff: template.requiresSignOff,
        employeeId,
        startedByUserId: actor.userId,
      })
      .onConflictDoNothing()
      .returning({ id: checklistRuns.id });

    if (!inserted) {
      return (await existing())!;
    }

    if (items.length > 0) {
      await transaction.insert(checklistRunItems).values(
        items.map((item, index) => ({
          runId: inserted.id,
          organizationId: actor.organizationId,
          templateItemId: item.id,
          textSnapshot: item.text,
          required: item.required,
          sortOrder: (index + 1) * 10,
        })),
      );
    }

    return inserted.id;
  });

  return getChecklistRun(database, actor, runId);
}

async function lockRun(transaction: DatabaseTransaction, actor: Actor, runId: string): Promise<RunRow> {
  const [run] = await transaction
    .select()
    .from(checklistRuns)
    .where(and(eq(checklistRuns.id, runId), eq(checklistRuns.locationId, actor.locationId)))
    .for("update");

  if (!run) {
    throw new NotFoundError("checklist");
  }

  return run;
}

async function assertMayWork(transaction: DatabaseTransaction, actor: Actor, run: RunRow) {
  assertRunWorkable({ status: run.status as "OPEN" | "COMPLETED", businessDate: run.businessDate }, await today(transaction, actor));

  if (!canWorkRun({ kind: run.kind as ChecklistKind, employeeId: run.employeeId }, await linkedEmployee(transaction, actor), isManager(actor))) {
    throw new AuthorizationError();
  }
}

export type ItemInput = {
  state: ChecklistItemState;
  skipReason?: string | null;
  note?: string | null;
  expectedVersion: number;
};

/** Policy 5: ticks an item done, skips it with a reason, or puts it back. Not audited. */
export async function setChecklistItem(database: Database, actor: Actor, runItemId: string, input: ItemInput): Promise<ChecklistRunView> {
  assertPermission(actor, "checklists.complete");

  const note = input.note?.trim() ? input.note.trim() : null;
  const skipReason = input.state === "SKIPPED" ? skipReasonOf(input.skipReason) : null;

  assertNoCardNumber(note, skipReason);

  if (note && note.length > 500) {
    throw new BusinessRuleError("NOTE_TOO_LONG", "Notes are up to 500 characters.");
  }

  const runId = await withTransaction(database, async (transaction) => {
    const [item] = await transaction.select().from(checklistRunItems).where(eq(checklistRunItems.id, runItemId));

    if (!item) {
      throw new NotFoundError("checklist item");
    }

    const run = await lockRun(transaction, actor, item.runId);

    await assertMayWork(transaction, actor, run);

    const changesTick = input.state !== item.state;

    if (changesTick && !canChangeTick({ state: item.state as ChecklistItemState, actedByUserId: item.actedByUserId }, actor.userId, isManager(actor))) {
      throw new BusinessRuleError("TICKED_BY_SOMEONE_ELSE", "Only the person who ticked this, or a manager, can change it.");
    }

    const acted = input.state === "OPEN" ? { actedByUserId: null, actedAt: null } : changesTick ? { actedByUserId: actor.userId, actedAt: new Date() } : {};

    assertVersionMatched(
      await transaction
        .update(checklistRunItems)
        .set({ state: input.state, skipReason, note, ...acted, version: nextVersion(checklistRunItems.version) })
        .where(and(eq(checklistRunItems.id, item.id), eq(checklistRunItems.version, input.expectedVersion)))
        .returning({ id: checklistRunItems.id }),
      { type: "checklist item", id: item.id },
    );

    return run.id;
  });

  return getChecklistRun(database, actor, runId);
}

/** Policy 5: completes a run once no required item is open, then freezes it. Audited. */
export async function completeChecklistRun(
  database: Database,
  actor: Actor,
  runId: string,
  input: { expectedVersion: number },
): Promise<ChecklistRunView> {
  assertPermission(actor, "checklists.complete");

  await withTransaction(database, async (transaction) => {
    const run = await lockRun(transaction, actor, runId);

    await assertMayWork(transaction, actor, run);

    const items = await transaction.select().from(checklistRunItems).where(eq(checklistRunItems.runId, run.id));

    assertCanComplete(items.map((item) => ({ required: item.required, state: item.state as ChecklistItemState })));
    assertVersionMatched(
      await transaction
        .update(checklistRuns)
        .set({ status: "COMPLETED", completedByUserId: actor.userId, completedAt: new Date(), version: nextVersion(checklistRuns.version) })
        .where(and(eq(checklistRuns.id, run.id), eq(checklistRuns.version, input.expectedVersion)))
        .returning({ id: checklistRuns.id }),
      { type: "checklist", id: run.id },
    );
    await recordAudit(transaction, actor, {
      action: "restaurant.checklist-completed",
      entityId: run.id,
      details: {
        templateName: run.templateNameSnapshot,
        kind: run.kind,
        businessDate: run.businessDate,
        itemsDone: items.filter((item) => item.state === "DONE").length,
        itemsSkipped: items.filter((item) => item.state === "SKIPPED").length,
        employeeId: run.employeeId,
      },
    });
  });

  return getChecklistRun(database, actor, runId);
}

/** Policy 5: a manager other than the one who completed it signs the run off, once. Audited. */
export async function signOffChecklistRun(
  database: Database,
  actor: Actor,
  runId: string,
  input: { expectedVersion: number },
): Promise<ChecklistRunView> {
  assertPermission(actor, "checklists.manage");

  await withTransaction(database, async (transaction) => {
    const run = await lockRun(transaction, actor, runId);

    assertCanSignOff({ ...run, status: run.status as "OPEN" | "COMPLETED" }, actor.userId);
    assertVersionMatched(
      await transaction
        .update(checklistRuns)
        .set({ signedOffByUserId: actor.userId, signedOffAt: new Date(), version: nextVersion(checklistRuns.version) })
        .where(and(eq(checklistRuns.id, run.id), eq(checklistRuns.version, input.expectedVersion)))
        .returning({ id: checklistRuns.id }),
      { type: "checklist", id: run.id },
    );
    await recordAudit(transaction, actor, {
      action: "restaurant.checklist-signed-off",
      entityId: run.id,
      details: { templateName: run.templateNameSnapshot, kind: run.kind, businessDate: run.businessDate, employeeId: run.employeeId },
    });
  });

  return getChecklistRun(database, actor, runId);
}

// ------------------------------------------------------------------------------ History

function withoutItems(view: ChecklistRunView): Omit<ChecklistRunView, "items"> {
  const copy: Partial<ChecklistRunView> = { ...view };

  delete copy.items;

  return copy as Omit<ChecklistRunView, "items">;
}

export type ChecklistHistoryRow = {
  businessDate: string;
  templateId: string;
  templateName: string;
  kind: ChecklistKind;
  status: DisplayStatus;
  run: Omit<ChecklistRunView, "items"> | null;
};

/**
 * Policy 5: what happened on each date, worked out on read. Every active template shows on
 * every date, with "Not started" where it has no run; side work shows its runs only.
 */
export async function listChecklistHistory(
  executor: DatabaseExecutor,
  actor: Actor,
  filter: { from: string; to: string; templateId?: string | null; kind?: ChecklistKind | null },
): Promise<{ today: string; rows: ChecklistHistoryRow[] }> {
  assertPermission(actor, "checklists.view");
  assertSearchRange(filter.from, filter.to, MAX_CHECKLIST_HISTORY_DAYS);

  const businessDate = await today(executor, actor);
  const templates = (await templatesAt(executor, actor.locationId, false)).filter(
    (template) => (!filter.templateId || template.id === filter.templateId) && (!filter.kind || template.kind === filter.kind),
  );
  const runs = await executor
    .select()
    .from(checklistRuns)
    .where(
      and(
        eq(checklistRuns.locationId, actor.locationId),
        gte(checklistRuns.businessDate, filter.from),
        lte(checklistRuns.businessDate, filter.to),
      ),
    );
  const visible = runs.filter((run) => templates.some((template) => template.id === run.templateId));
  const views = await runViews(executor, actor, visible, { today: businessDate, actorEmployeeId: null, withItems: false });
  // A template isn't "not started" on dates before it existed (rule 13: its first business date).
  const firstDates = new Map(
    await Promise.all(
      templates.map(async (template) => [template.id, (await readLocationClock(executor, actor.locationId, template.createdAt)).businessDate] as const),
    ),
  );
  const rows: ChecklistHistoryRow[] = [];

  for (const date of datesDescending(filter.from, filter.to < businessDate ? filter.to : businessDate)) {
    for (const template of templates) {
      const onDate = views.filter((view) => view.templateId === template.id && view.businessDate === date);
      const base = { businessDate: date, templateId: template.id, templateName: template.name, kind: template.kind as ChecklistKind };

      if (onDate.length > 0) {
        rows.push(...onDate.map((view) => ({ ...base, templateName: view.templateName, status: view.status, run: withoutItems(view) })));
      } else if (template.kind !== "SIDE_WORK" && template.active && date >= firstDates.get(template.id)!) {
        rows.push({ ...base, status: displayStatus(null, businessDate), run: null });
      }
    }
  }

  return { today: businessDate, rows };
}
