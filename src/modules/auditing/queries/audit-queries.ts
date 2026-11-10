import { and, desc, eq, gte, isNull, lt, or } from "drizzle-orm";

import { auditEvents, employees, locations, locationSettings, users } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { AuthorizationError, NotFoundError, ValidationError } from "@/shared/errors/app-error";
import {
  type BusinessDateSettings,
  businessDateOf,
  businessDateRangeBounds,
} from "@/shared/time/business-date-service";

import { AUDIT_MAX_RANGE_DAYS, AUDIT_PAGE_SIZE, type AuditFilters } from "../validators/audit-filters";

export type AuditEventView = {
  sequence: number;
  occurredAt: string;
  locationId: string | null;
  actorType: string;
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  category: string;
  entityType: string;
  entityId: string | null;
  requestId: string | null;
  before: unknown;
  after: unknown;
  details: unknown;
};

export type AuditPage = { timeZone: string; events: AuditEventView[]; nextBefore: number | null };

async function loadClock(
  executor: DatabaseExecutor,
  actor: Actor,
  locationId: string,
): Promise<BusinessDateSettings> {
  const [clock] = await executor
    .select({ timeZone: locations.timezone, businessDayCutoff: locationSettings.businessDayCutoff })
    .from(locations)
    .innerJoin(locationSettings, eq(locationSettings.locationId, locations.id))
    .where(and(eq(locations.id, locationId), eq(locations.organizationId, actor.organizationId)));

  if (!clock) {
    throw new NotFoundError("location");
  }

  return clock as BusinessDateSettings;
}

/** The actor's location's current business date, for the viewer's default range. */
export async function currentAuditBusinessDate(executor: DatabaseExecutor, actor: Actor): Promise<string> {
  return businessDateOf(new Date(), await loadClock(executor, actor, actor.locationId));
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

/**
 * One page of the audit trail, newest first. The actor sees their location's events and
 * the organization-level ones (roles, users, sign-in). Reading the trail is not audited.
 */
export async function listAuditEvents(
  executor: DatabaseExecutor,
  actor: Actor,
  filters: AuditFilters,
): Promise<AuditPage> {
  if (!actor.permissions.has("audit.view") || filters.locationId !== actor.locationId) {
    throw new AuthorizationError();
  }

  const span = daysBetween(filters.from, filters.to);

  if (span < 0) {
    throw new ValidationError("The start date must be on or before the end date.");
  }

  if (span >= AUDIT_MAX_RANGE_DAYS) {
    throw new ValidationError(`Choose a range of at most ${AUDIT_MAX_RANGE_DAYS} days.`);
  }

  const clock = await loadClock(executor, actor, filters.locationId);
  const { start, end } = businessDateRangeBounds(filters.from, filters.to, clock);
  const rows = await executor
    .select({
      sequence: auditEvents.sequence,
      occurredAt: auditEvents.occurredAt,
      locationId: auditEvents.locationId,
      actorType: auditEvents.actorType,
      actorUserId: auditEvents.actorUserId,
      actorEmail: users.email,
      actorFirstName: employees.firstName,
      actorPreferredName: employees.preferredName,
      actorLastName: employees.lastName,
      action: auditEvents.action,
      category: auditEvents.category,
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      requestId: auditEvents.requestId,
      before: auditEvents.before,
      after: auditEvents.after,
      details: auditEvents.details,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .leftJoin(employees, eq(employees.id, auditEvents.actorEmployeeId))
    .where(
      and(
        eq(auditEvents.organizationId, actor.organizationId),
        or(eq(auditEvents.locationId, filters.locationId), isNull(auditEvents.locationId)),
        gte(auditEvents.occurredAt, start),
        lt(auditEvents.occurredAt, end),
        filters.category ? eq(auditEvents.category, filters.category) : undefined,
        filters.action ? eq(auditEvents.action, filters.action) : undefined,
        filters.actorUserId ? eq(auditEvents.actorUserId, filters.actorUserId) : undefined,
        filters.entityType ? eq(auditEvents.entityType, filters.entityType) : undefined,
        filters.entityId ? eq(auditEvents.entityId, filters.entityId) : undefined,
        filters.before ? lt(auditEvents.sequence, filters.before) : undefined,
      ),
    )
    .orderBy(desc(auditEvents.sequence))
    .limit(AUDIT_PAGE_SIZE);

  return {
    timeZone: clock.timeZone,
    events: rows.map((row) => ({
      sequence: row.sequence,
      occurredAt: row.occurredAt.toISOString(),
      locationId: row.locationId,
      actorType: row.actorType,
      actorUserId: row.actorUserId,
      actorName: row.actorLastName
        ? `${row.actorPreferredName ?? row.actorFirstName} ${row.actorLastName}`
        : row.actorEmail,
      action: row.action,
      category: row.category,
      entityType: row.entityType,
      entityId: row.entityId,
      requestId: row.requestId,
      before: row.before,
      after: row.after,
      details: row.details,
    })),
    nextBefore: rows.length === AUDIT_PAGE_SIZE ? rows[rows.length - 1]!.sequence : null,
  };
}
