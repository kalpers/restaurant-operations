import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import {
  cashDrawerMovements,
  cashDrawers,
  cashDrawerSessions,
  locationSettings,
  orderRefunds,
  settlements,
  settlementTenders,
} from "@/db/schema";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { readOrderLocation } from "@/modules/orders/repositories/order-repository";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { drawerVariance, expectedCash, parseNonNegativeMoney, type DrawerTotals } from "../rules/drawer-math";
import { looksLikeCardNumber, parseMoney } from "../rules/settlement-math";
import { assertPermission } from "./access";

// Phase 17 cash drawers (approved policies E28-E35). Record only. A drawer session is one
// shift of a drawer: opened with a float, then cash tenders, cash refunds, paid-ins and
// paid-outs are recorded into it, and it is closed with a count. Expected cash and the
// variance are snapshotted at close; a closed session never changes.

export const DRAWER_OPEN_SCOPE = "drawers.open";
export const DRAWER_MOVEMENT_SCOPE = "drawers.movement";
export const DRAWER_CLOSE_SCOPE = "drawers.close";

type SessionRow = typeof cashDrawerSessions.$inferSelect;

function drawerEvent(actor: Actor, eventType: string, session: { id: string; drawerId: string }, at: Date) {
  return {
    organizationId: actor.organizationId,
    locationId: actor.locationId,
    eventType,
    aggregateType: "cash_drawer_session",
    aggregateId: session.id,
    payload: { sessionId: session.id, drawerId: session.drawerId },
    occurredAt: at,
  };
}

function requireText(value: string, field: string, max: number): string {
  const text = value.trim();

  if (text.length === 0 || text.length > max) {
    throw new BusinessRuleError("INVALID_TEXT", `Enter a ${field} of up to ${max} characters.`);
  }

  if (looksLikeCardNumber(text)) {
    throw new BusinessRuleError("CARD_DATA_REFUSED", "Don't enter card numbers.");
  }

  return text;
}

// ------------------------------------------------------------------ drawers and setting

export async function listDrawers(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "drawers.view");

  const drawers = await executor
    .select()
    .from(cashDrawers)
    .where(and(eq(cashDrawers.organizationId, actor.organizationId), eq(cashDrawers.locationId, actor.locationId)))
    .orderBy(asc(cashDrawers.code));
  const open = await executor
    .select()
    .from(cashDrawerSessions)
    .where(and(eq(cashDrawerSessions.locationId, actor.locationId), eq(cashDrawerSessions.status, "OPEN")));

  return drawers.map((drawer) => ({
    ...drawer,
    openSession: open.find((session) => session.drawerId === drawer.id) ?? null,
  }));
}

export async function createDrawer(database: Database, actor: Actor, input: { code: string; name: string }) {
  assertPermission(actor, "drawers.manage");

  try {
    return await withTransaction(database, async (transaction) => {
      const [row] = await transaction
        .insert(cashDrawers)
        .values({
          organizationId: actor.organizationId,
          locationId: actor.locationId,
          code: input.code,
          name: requireText(input.name, "name", 80),
        })
        .returning();

      await recordAudit(transaction, actor, {
        action: "drawers.drawer-created",
        entityId: row!.id,
        after: { code: row!.code, name: row!.name, active: row!.active },
      });

      return row!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("CODE_TAKEN", "Another drawer at this location already uses that code.");
    }

    throw error;
  }
}

export async function updateDrawer(
  database: Database,
  actor: Actor,
  drawerId: string,
  input: { name: string; active: boolean; expectedVersion: number },
) {
  assertPermission(actor, "drawers.manage");

  return withTransaction(database, async (transaction) => {
    const [before] = await transaction
      .select()
      .from(cashDrawers)
      .where(
        and(
          eq(cashDrawers.id, drawerId),
          eq(cashDrawers.organizationId, actor.organizationId),
          eq(cashDrawers.locationId, actor.locationId),
        ),
      )
      .for("update");

    if (!before) {
      throw new NotFoundError("cash drawer");
    }

    if (before.version !== input.expectedVersion) {
      throw new ConcurrencyError("cash drawer", drawerId);
    }

    if (!input.active) {
      const [open] = await transaction
        .select({ id: cashDrawerSessions.id })
        .from(cashDrawerSessions)
        .where(and(eq(cashDrawerSessions.drawerId, drawerId), eq(cashDrawerSessions.status, "OPEN")));

      if (open) {
        throw new BusinessRuleError("DRAWER_SESSION_OPEN", "Close this drawer's session before deactivating it.");
      }
    }

    const [updated] = await transaction
      .update(cashDrawers)
      .set({
        name: requireText(input.name, "name", 80),
        active: input.active,
        version: sql`${cashDrawers.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(cashDrawers.id, drawerId))
      .returning();

    await recordAudit(transaction, actor, {
      action: "drawers.drawer-updated",
      entityId: drawerId,
      before: { code: before.code, name: before.name, active: before.active },
      after: { code: updated!.code, name: updated!.name, active: updated!.active },
    });

    return updated!;
  });
}

/** Whether cash at the actor's Location needs an open drawer session (policy E30). */
export async function getDrawerSetting(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "drawers.view");

  const [row] = await executor
    .select({ required: locationSettings.cashDrawerRequired, version: locationSettings.version })
    .from(locationSettings)
    .where(eq(locationSettings.locationId, actor.locationId));

  if (!row) {
    throw new NotFoundError("location");
  }

  return row;
}

export async function setCashDrawerRequired(
  database: Database,
  actor: Actor,
  input: { required: boolean; expectedVersion: number },
) {
  assertPermission(actor, "drawers.manage");

  return withTransaction(database, async (transaction) => {
    const [updated] = await transaction
      .update(locationSettings)
      .set({
        cashDrawerRequired: input.required,
        version: sql`${locationSettings.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(locationSettings.locationId, actor.locationId), eq(locationSettings.version, input.expectedVersion)))
      .returning({ required: locationSettings.cashDrawerRequired, version: locationSettings.version });

    if (!updated) {
      throw new ConcurrencyError("location settings", actor.locationId);
    }

    await recordAudit(transaction, actor, {
      action: "drawers.setting-changed",
      entityId: actor.locationId,
      after: { required: updated.required },
    });

    return updated;
  });
}

// ------------------------------------------------------------------ sessions

/** A session at the actor's Location, locked as asked, or not found. */
async function findSession(
  transaction: DatabaseTransaction,
  actor: Actor,
  sessionId: string,
  lock: "update" | "share",
): Promise<SessionRow> {
  const [row] = await transaction
    .select()
    .from(cashDrawerSessions)
    .where(
      and(
        eq(cashDrawerSessions.id, sessionId),
        eq(cashDrawerSessions.organizationId, actor.organizationId),
        eq(cashDrawerSessions.locationId, actor.locationId),
      ),
    )
    .for(lock);

  if (!row) {
    throw new NotFoundError("drawer session");
  }

  return row;
}

/**
 * The trusted check tenders and refunds use for cash (policies E29-E30, E33): the session
 * given must be OPEN at the actor's Location (locked FOR SHARE, so a close waits); with none
 * given, the Location must not require one. Call after the order and settlement locks.
 */
export async function resolveCashDrawerSession(
  transaction: DatabaseTransaction,
  actor: Actor,
  sessionId: string | null,
  required: boolean,
): Promise<string | null> {
  if (sessionId === null) {
    if (required) {
      throw new BusinessRuleError(
        "CASH_DRAWER_REQUIRED",
        "Choose an open cash drawer for cash at this location. A manager can open one.",
      );
    }

    return null;
  }

  const session = await findSession(transaction, actor, sessionId, "share");

  if (session.status !== "OPEN") {
    throw new BusinessRuleError("DRAWER_SESSION_CLOSED", "That drawer has been closed. Choose an open drawer.");
  }

  return session.id;
}

async function drawerFacts(executor: DatabaseExecutor, session: SessionRow): Promise<DrawerTotals> {
  const tenders = await executor
    .select({ status: settlementTenders.status, amount: settlementTenders.amount, tipAmount: settlementTenders.tipAmount })
    .from(settlementTenders)
    .where(eq(settlementTenders.cashDrawerSessionId, session.id));
  const movements = await executor
    .select({ movementType: cashDrawerMovements.movementType, amount: cashDrawerMovements.amount })
    .from(cashDrawerMovements)
    .where(eq(cashDrawerMovements.sessionId, session.id));
  const refunds = await executor
    .select({ status: orderRefunds.status, amount: orderRefunds.amount })
    .from(orderRefunds)
    .where(eq(orderRefunds.cashDrawerSessionId, session.id));

  return expectedCash({ openingFloat: session.openingFloat, tenders, movements, refunds });
}

export type SessionSummary = SessionRow & { totals: DrawerTotals; drawerCode: string; drawerName: string };

/** Sessions at the actor's Location, newest first, each with its running totals. */
export async function listDrawerSessions(
  executor: DatabaseExecutor,
  actor: Actor,
  options: { status?: "OPEN" | "CLOSED"; limit?: number } = {},
): Promise<SessionSummary[]> {
  assertPermission(actor, "drawers.view");

  const rows = await executor
    .select({ session: cashDrawerSessions, code: cashDrawers.code, name: cashDrawers.name })
    .from(cashDrawerSessions)
    .innerJoin(cashDrawers, eq(cashDrawers.id, cashDrawerSessions.drawerId))
    .where(
      and(
        eq(cashDrawerSessions.organizationId, actor.organizationId),
        eq(cashDrawerSessions.locationId, actor.locationId),
        options.status ? eq(cashDrawerSessions.status, options.status) : undefined,
      ),
    )
    .orderBy(desc(cashDrawerSessions.openedAt), desc(cashDrawerSessions.id))
    .limit(options.limit ?? 50);

  return Promise.all(
    rows.map(async (row) => ({
      ...row.session,
      drawerCode: row.code,
      drawerName: row.name,
      totals: await drawerFacts(executor, row.session),
    })),
  );
}

export async function openDrawerSession(
  database: Database,
  actor: Actor,
  drawerId: string,
  input: { openingFloat: string; idempotencyKey: string },
): Promise<SessionRow & { replayed: boolean }> {
  assertPermission(actor, "drawers.operate");

  const openingFloat = parseNonNegativeMoney(input.openingFloat, "starting float");
  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent<SessionRow>(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: DRAWER_OPEN_SCOPE,
        key: input.idempotencyKey,
        actorUserId: actor.userId,
        request: { drawerId, openingFloat },
      },
      async (idempotencyRecordId) => {
        // The drawer lock serializes opening, so session numbers and "one open" can't race.
        const [drawer] = await transaction
          .select()
          .from(cashDrawers)
          .where(
            and(
              eq(cashDrawers.id, drawerId),
              eq(cashDrawers.organizationId, actor.organizationId),
              eq(cashDrawers.locationId, actor.locationId),
            ),
          )
          .for("update");

        if (!drawer) {
          throw new NotFoundError("cash drawer");
        }

        if (!drawer.active) {
          throw new BusinessRuleError("DRAWER_INACTIVE", "This drawer isn't active.");
        }

        const [open] = await transaction
          .select({ id: cashDrawerSessions.id })
          .from(cashDrawerSessions)
          .where(and(eq(cashDrawerSessions.drawerId, drawerId), eq(cashDrawerSessions.status, "OPEN")));

        if (open) {
          throw new BusinessRuleError("DRAWER_ALREADY_OPEN", "This drawer already has an open session.");
        }

        const [last] = await transaction
          .select({ value: max(cashDrawerSessions.sessionNumber) })
          .from(cashDrawerSessions)
          .where(eq(cashDrawerSessions.drawerId, drawerId));
        const now = new Date();
        const location = await readOrderLocation(transaction, actor.locationId, now);
        const [session] = await transaction
          .insert(cashDrawerSessions)
          .values({
            organizationId: actor.organizationId,
            locationId: actor.locationId,
            drawerId,
            sessionNumber: (last?.value ?? 0) + 1,
            businessDate: location.businessDate,
            openingFloat,
            openedByUserId: actor.userId,
            openedAt: now,
            openIdempotencyRecordId: idempotencyRecordId,
          })
          .returning();

        await writeOutboxEvents(transaction, [drawerEvent(actor, "drawer.session-opened", session!, now)]);
        await recordAudit(transaction, actor, {
          action: "drawers.session-opened",
          entityId: session!.id,
          occurredAt: now,
          after: { drawerCode: drawer.code, sessionNumber: session!.sessionNumber, openingFloat },
        });

        return session!;
      },
    ),
  );

  return { ...outcome.response, replayed: outcome.replayed };
}

export async function recordDrawerMovement(
  database: Database,
  actor: Actor,
  sessionId: string,
  input: { movementType: "PAID_IN" | "PAID_OUT"; amount: string; reason: string; idempotencyKey: string },
) {
  assertPermission(actor, "drawers.operate");

  const amount = parseMoney(input.amount, "amount");

  if (amount === "0.00") {
    throw new BusinessRuleError("INVALID_AMOUNT", "Enter an amount greater than zero.");
  }

  const reason = requireText(input.reason, "reason", 200);
  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: DRAWER_MOVEMENT_SCOPE,
        key: input.idempotencyKey,
        actorUserId: actor.userId,
        request: { sessionId, movementType: input.movementType, amount, reason },
      },
      async (idempotencyRecordId) => {
        const session = await findSession(transaction, actor, sessionId, "share");

        if (session.status !== "OPEN") {
          throw new BusinessRuleError("DRAWER_SESSION_CLOSED", "That drawer has been closed.");
        }

        const now = new Date();
        const [movement] = await transaction
          .insert(cashDrawerMovements)
          .values({
            sessionId,
            movementType: input.movementType,
            amount,
            reason,
            recordedByUserId: actor.userId,
            recordedAt: now,
            idempotencyRecordId,
          })
          .returning();

        await writeOutboxEvents(transaction, [drawerEvent(actor, "drawer.movement-recorded", session, now)]);
        await recordAudit(transaction, actor, {
          action: input.movementType === "PAID_IN" ? "drawers.paid-in" : "drawers.paid-out",
          entityId: sessionId,
          occurredAt: now,
          after: { movementId: movement!.id, amount, reason },
        });

        return { id: movement!.id, sessionId, movementType: movement!.movementType, amount };
      },
    ),
  );

  return { ...outcome.response, replayed: outcome.replayed };
}

export type CloseResult = { sessionId: string; expected: string; counted: string; variance: string; totals: DrawerTotals; version: number };

export async function closeDrawerSession(
  database: Database,
  actor: Actor,
  sessionId: string,
  input: { countedAmount: string; closeNote: string | null; expectedVersion: number; idempotencyKey: string },
): Promise<CloseResult & { replayed: boolean }> {
  assertPermission(actor, "drawers.operate");

  const counted = parseNonNegativeMoney(input.countedAmount, "counted amount");
  const closeNote = input.closeNote?.trim() ? requireText(input.closeNote, "note", 500) : null;
  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent<CloseResult>(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: DRAWER_CLOSE_SCOPE,
        key: input.idempotencyKey,
        actorUserId: actor.userId,
        request: { sessionId, counted, closeNote, expectedVersion: input.expectedVersion },
      },
      async () => {
        const session = await findSession(transaction, actor, sessionId, "update");

        if (session.version !== input.expectedVersion) {
          throw new ConcurrencyError("drawer session", sessionId);
        }

        if (session.status !== "OPEN") {
          throw new BusinessRuleError("DRAWER_SESSION_CLOSED", "That drawer is already closed.");
        }

        // A tender in an OPEN settlement could still be voided, which would change this count.
        const [pending] = await transaction
          .select({ id: settlementTenders.id })
          .from(settlementTenders)
          .innerJoin(settlements, eq(settlements.id, settlementTenders.settlementId))
          .where(
            and(
              eq(settlementTenders.cashDrawerSessionId, sessionId),
              eq(settlementTenders.status, "RECORDED"),
              eq(settlements.status, "OPEN"),
            ),
          )
          .limit(1);

        if (pending) {
          throw new BusinessRuleError(
            "DRAWER_HAS_OPEN_SETTLEMENTS",
            "A check with cash in this drawer is still being settled. Finish or cancel it first.",
          );
        }

        const totals = await drawerFacts(transaction, session);
        const variance = drawerVariance(counted, totals.expected);
        const now = new Date();
        const [closed] = await transaction
          .update(cashDrawerSessions)
          .set({
            status: "CLOSED",
            closedByUserId: actor.userId,
            closedAt: now,
            countedAmount: counted,
            expectedAmount: totals.expected,
            variance,
            closeNote,
            version: sql`${cashDrawerSessions.version} + 1`,
            updatedAt: now,
          })
          .where(eq(cashDrawerSessions.id, sessionId))
          .returning();

        await writeOutboxEvents(transaction, [drawerEvent(actor, "drawer.session-closed", session, now)]);
        await recordAudit(transaction, actor, {
          action: "drawers.session-closed",
          entityId: sessionId,
          occurredAt: now,
          after: {
            sessionNumber: session.sessionNumber,
            openingFloat: session.openingFloat,
            expectedAmount: totals.expected,
            countedAmount: counted,
            variance,
          },
        });

        return { sessionId, expected: totals.expected, counted, variance, totals, version: closed!.version };
      },
    ),
  );

  return { ...outcome.response, replayed: outcome.replayed };
}

/** Open sessions at the actor's Location, for the cash tender picker. */
export async function listOpenSessionsForCash(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "drawers.view");

  const rows = await executor
    .select({ id: cashDrawerSessions.id, sessionNumber: cashDrawerSessions.sessionNumber, code: cashDrawers.code, name: cashDrawers.name })
    .from(cashDrawerSessions)
    .innerJoin(cashDrawers, eq(cashDrawers.id, cashDrawerSessions.drawerId))
    .where(
      and(
        eq(cashDrawerSessions.organizationId, actor.organizationId),
        eq(cashDrawerSessions.locationId, actor.locationId),
        inArray(cashDrawerSessions.status, ["OPEN"]),
      ),
    )
    .orderBy(asc(cashDrawers.code));

  return rows;
}
