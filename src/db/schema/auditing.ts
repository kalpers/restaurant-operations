import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { createdAt, timestamptz } from "../helpers/timestamps";
import { users } from "./auth";
import { employees } from "./employees";
import { locations, organizations } from "./organization";

/** The audit categories (README section 20). Kept in step with the auditing registry. */
export const AUDIT_CATEGORIES = [
  "ACCESS",
  "SECURITY",
  "HR",
  "SCHEDULING",
  "ORDERS",
  "MENU",
  "INVENTORY",
  "SETTLEMENTS",
  "REPORTING",
  "SYSTEM",
  // Phase 20: location settings changes.
  "ORGANIZATION",
  // Phase 21: guest profiles (policy 20).
  "GUESTS",
] as const;

/**
 * Business audit trail (README section 20): who did what, when, where and to which entity.
 * Append-only: a trigger refuses UPDATE, DELETE and TRUNCATE. Rows are written inside the
 * transaction of the action they record, and hold only allow-listed fields, never passwords,
 * tokens, payment data, wage amounts or personal HR values. Domain histories stay separate.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuidPrimaryKey(),
    /** Insert order, used to page through the trail. */
    sequence: bigint("sequence", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** Null for organization-level events, such as role changes and sign-in. */
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    actorType: text("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    /** The employee linked to the acting user when the event was written, if any. */
    actorEmployeeId: uuid("actor_employee_id").references(() => employees.id, { onDelete: "restrict" }),
    /** `domain.action-name`, for example `orders.item-voided`. */
    action: text("action").notNull(),
    category: text("category").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    occurredAt: timestamptz("occurred_at").notNull(),
    requestId: text("request_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    details: jsonb("details"),
    createdAt: createdAt(),
  },
  (table) => [
    unique("audit_events_sequence_unique").on(table.sequence),
    check("audit_events_action_format", sql`${table.action} ~ '^[a-z]+[.][a-z-]+$'`),
    check(
      "audit_events_category_valid",
      sql`${table.category} IN ('ACCESS', 'SECURITY', 'HR', 'SCHEDULING', 'ORDERS', 'MENU', 'INVENTORY', 'SETTLEMENTS', 'REPORTING', 'SYSTEM', 'ORGANIZATION', 'GUESTS')`,
    ),
    check("audit_events_actor_type_valid", sql`${table.actorType} IN ('USER', 'SYSTEM')`),
    check(
      "audit_events_actor_consistent",
      sql`(${table.actorType} = 'USER') = (${table.actorUserId} IS NOT NULL)`,
    ),
    check("audit_events_request_id_length", sql`char_length(${table.requestId}) <= 100`),
    index("audit_events_org_sequence_idx").on(table.organizationId, table.sequence),
    index("audit_events_location_sequence_idx").on(table.locationId, table.sequence),
    index("audit_events_entity_idx").on(table.entityType, table.entityId),
    index("audit_events_actor_sequence_idx").on(table.actorUserId, table.sequence),
  ],
);
