import { and, asc, between, desc, eq, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { employees, tipDeclarations } from "@/db/schema";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { findWorkedEntries } from "@/modules/scheduling/queries/worked-time";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { looksLikeCardNumber, parseMoney } from "../rules/settlement-math";
import { actorHolds, assertPermission } from "./access";
import { findFinalizedDistribution } from "./tip-service";

// Phase 20 (policy 20, D19): cash tip declarations. Record only: what an employee says they
// kept in cash on a business date. Never part of the pool and never paid out. An employee
// declares their own under `timeclock.punch` for a date they worked; a manager declares or
// corrects anyone's under `tips.manage` (audited, without the amount, like Phase 18 tip
// audit). Nothing changes once that date's tips are finalized.

export type DeclareTipsInput = {
  /** Omitted for the signed-in employee's own declaration. */
  employeeId?: string;
  businessDate: string;
  amount: string;
  note?: string | null;
  /** Required to change an existing declaration. */
  expectedVersion?: number | null;
};

async function selfEmployeeId(executor: DatabaseExecutor, actor: Actor): Promise<string> {
  const [linked] = await executor
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.userId, actor.userId), eq(employees.organizationId, actor.organizationId)));

  if (!linked) {
    throw new BusinessRuleError("NO_LINKED_EMPLOYEE", "Your login isn't linked to an employee record.");
  }

  return linked.id;
}

export async function declareTips(database: Database, actor: Actor, input: DeclareTipsInput) {
  const amount = parseMoney(input.amount, "declared tips");
  const note = input.note?.trim() || null;

  if (note && (note.length > 300 || looksLikeCardNumber(note))) {
    throw new BusinessRuleError("INVALID_NOTE", "Keep the note under 300 characters, with no card numbers.");
  }

  return withTransaction(database, async (transaction) => {
    const own = await selfEmployeeId(transaction, actor).catch(() => null);
    const forSelf = input.employeeId === undefined || input.employeeId === own;

    if (forSelf) {
      assertPermission(actor, "timeclock.punch");
    } else {
      assertPermission(actor, "tips.manage");
    }

    const employeeId = forSelf ? (own ?? (await selfEmployeeId(transaction, actor))) : input.employeeId!;
    const [employee] = await transaction
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.id, employeeId), eq(employees.organizationId, actor.organizationId)));

    if (!employee) {
      throw new NotFoundError("employee");
    }

    if (await findFinalizedDistribution(transaction, { locationId: actor.locationId, businessDate: input.businessDate })) {
      throw new BusinessRuleError(
        "TIP_DISTRIBUTION_FINALIZED",
        "Tips for that date are finalized. A manager must void the distribution first.",
      );
    }

    if (forSelf) {
      const worked = await findWorkedEntries(transaction, {
        locationId: actor.locationId,
        from: input.businessDate,
        to: input.businessDate,
        employeeIds: [employeeId],
      });

      if (worked.length === 0) {
        throw new BusinessRuleError("NO_TIME_WORKED", "You can declare tips only for a date you worked here.");
      }
    }

    const [existing] = await transaction
      .select()
      .from(tipDeclarations)
      .where(
        and(
          eq(tipDeclarations.employeeId, employeeId),
          eq(tipDeclarations.locationId, actor.locationId),
          eq(tipDeclarations.businessDate, input.businessDate),
        ),
      )
      .for("update");
    const now = new Date();
    let row: typeof tipDeclarations.$inferSelect;

    if (existing) {
      if (input.expectedVersion !== existing.version) {
        throw new ConcurrencyError("tip declaration", existing.id);
      }

      [row] = (await transaction
        .update(tipDeclarations)
        .set({
          amount,
          note,
          declaredByUserId: actor.userId,
          declaredAt: now,
          updatedAt: now,
          version: sql`${tipDeclarations.version} + 1`,
        })
        .where(eq(tipDeclarations.id, existing.id))
        .returning()) as [typeof tipDeclarations.$inferSelect];
    } else {
      try {
        [row] = (await transaction
          .insert(tipDeclarations)
          .values({
            organizationId: actor.organizationId,
            locationId: actor.locationId,
            employeeId,
            businessDate: input.businessDate,
            amount,
            note,
            declaredByUserId: actor.userId,
            declaredAt: now,
          })
          .returning()) as [typeof tipDeclarations.$inferSelect];
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError("TIP_DECLARATION_EXISTS", "That date already has a declaration. Reload and change it.");
        }

        throw error;
      }
    }

    // Manager declarations are audited; self declarations aren't (like punches).
    if (!forSelf) {
      await recordAudit(transaction, actor, {
        action: "tips.declaration-recorded",
        entityId: row.id,
        details: { employeeId, businessDate: input.businessDate, changed: existing !== undefined },
      });
    }

    return row;
  });
}

/** Declarations at the actor's location in a date range (`tips.manage`), or the actor's own. */
export async function listTipDeclarations(
  executor: DatabaseExecutor,
  actor: Actor,
  input: { from: string; to: string; own?: boolean },
) {
  const own = input.own || !actorHolds(actor, "tips.manage");

  if (own) {
    assertPermission(actor, "timeclock.punch");
  }

  const employeeId = own ? await selfEmployeeId(executor, actor).catch(() => null) : null;

  if (own && !employeeId) {
    return [];
  }

  return executor
    .select({
      id: tipDeclarations.id,
      employeeId: tipDeclarations.employeeId,
      employeeName: sql<string>`COALESCE(${employees.preferredName}, ${employees.firstName}) || ' ' || ${employees.lastName}`,
      businessDate: tipDeclarations.businessDate,
      amount: tipDeclarations.amount,
      note: tipDeclarations.note,
      version: tipDeclarations.version,
    })
    .from(tipDeclarations)
    .innerJoin(employees, eq(employees.id, tipDeclarations.employeeId))
    .where(
      and(
        eq(tipDeclarations.locationId, actor.locationId),
        between(tipDeclarations.businessDate, input.from, input.to),
        employeeId ? eq(tipDeclarations.employeeId, employeeId) : undefined,
      ),
    )
    .orderBy(desc(tipDeclarations.businessDate), asc(employees.employeeNumber));
}
