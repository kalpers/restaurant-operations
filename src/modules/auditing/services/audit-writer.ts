import { sql } from "drizzle-orm";

import { auditEvents } from "@/db/schema";
import {
  type DatabaseExecutor,
  type DatabaseTransaction,
  withExecutorTransaction,
} from "@/db/transactions/transaction-context";
import { currentRequestId } from "@/shared/http/request-context";

import { type AuditAction, auditActionDefinition } from "../audit-actions";
import { type AuditPayload, sanitizeAuditPayload } from "../rules/sanitize";

/**
 * A signed-in user acting at a location, the system acting for an organization, or (Phase 22,
 * D10) a guest on the public booking page, who has no user.
 */
export type AuditActor =
  | { userId: string; organizationId: string; locationId: string | null }
  | { system: true; organizationId: string; locationId?: string | null }
  | { guest: true; organizationId: string; locationId: string };

export type AuditInput = {
  action: AuditAction;
  entityId: string | null;
  before?: AuditPayload | null;
  after?: AuditPayload | null;
  details?: AuditPayload | null;
  occurredAt?: Date;
};

/**
 * Appends audit events inside the caller's transaction, so each exists only if its action
 * committed. It takes a transaction, never a bare database handle. Fields the registry
 * doesn't list are dropped; the acting user's employee is resolved in the same INSERT.
 */
export async function recordAudit(
  transaction: DatabaseTransaction,
  actor: AuditActor,
  inputs: AuditInput | readonly AuditInput[],
): Promise<void> {
  const list = Array.isArray(inputs) ? (inputs as readonly AuditInput[]) : [inputs as AuditInput];

  if (list.length === 0) {
    return;
  }

  const requestId = currentRequestId();
  const userId = "userId" in actor ? actor.userId : null;
  const actorEmployeeId = userId
    ? sql`(SELECT ${sql.identifier("id")} FROM ${sql.identifier("employees")} WHERE ${sql.identifier("user_id")} = ${userId})`
    : null;

  await transaction.insert(auditEvents).values(
    list.map((input) => {
      const definition = auditActionDefinition(input.action);
      const changedOnly = definition.changedOnly ?? [];

      return {
        organizationId: actor.organizationId,
        locationId: definition.scope === "ORGANIZATION" ? null : (actor.locationId ?? null),
        actorType: userId ? "USER" : "guest" in actor ? "GUEST" : "SYSTEM",
        actorUserId: userId,
        actorEmployeeId,
        action: input.action,
        category: definition.category,
        entityType: definition.entityType,
        entityId: input.entityId,
        occurredAt: input.occurredAt ?? new Date(),
        requestId,
        before: sanitizeAuditPayload(input.before, definition.fields, changedOnly, input.after),
        after: sanitizeAuditPayload(input.after, definition.fields, changedOnly, input.before),
        details: sanitizeAuditPayload(input.details, definition.fields, changedOnly),
      };
    }),
  );
}

/**
 * Runs a restricted read and records who viewed it in one transaction. The audit row is
 * written only after the read succeeds, and if it can't be written no data is returned.
 */
export function auditedRead<Result>(
  executor: DatabaseExecutor,
  actor: AuditActor,
  input: AuditInput,
  read: (transaction: DatabaseTransaction) => Promise<Result>,
): Promise<Result> {
  return withExecutorTransaction(executor, async (transaction) => {
    const result = await read(transaction);

    await recordAudit(transaction, actor, input);

    return result;
  });
}
