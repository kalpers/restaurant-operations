import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { activeColumn, uuidPrimaryKey } from "../helpers/columns";
import { money } from "../helpers/numeric";
import { businessDate, createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { idempotencyRecords } from "./infrastructure";
import { locations, organizations } from "./organization";

// Phase 17 cash drawers, owned by Settlements (approved policies E28-E33). A drawer is a
// configured place cash lives; a session is one shift of it, opened with a float and closed
// with a count. Cash tenders and cash refunds are recorded into an OPEN session. Expected
// cash and the variance are snapshotted at close. Record only: nothing moves money.

export const cashDrawers = pgTable(
  "cash_drawers",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "cash_drawers_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    unique("cash_drawers_location_code_unique").on(table.locationId, table.code),
    unique("cash_drawers_id_location_unique").on(table.id, table.locationId),
    check("cash_drawers_code_not_blank", sql`length(trim(${table.code})) > 0`),
    check("cash_drawers_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ],
);

export const cashDrawerSessions = pgTable(
  "cash_drawer_sessions",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    drawerId: uuid("drawer_id").notNull(),
    sessionNumber: integer("session_number").notNull(),
    status: text("status").notNull().default("OPEN"),
    businessDate: businessDate().notNull(),
    openingFloat: money("opening_float").notNull(),
    openedByUserId: uuid("opened_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    openedAt: timestamptz("opened_at").notNull(),
    closedByUserId: uuid("closed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    closedAt: timestamptz("closed_at"),
    /** Snapshots taken at close. Variance = counted - expected (negative means short). */
    countedAmount: money("counted_amount"),
    expectedAmount: money("expected_amount"),
    variance: money("variance"),
    closeNote: text("close_note"),
    openIdempotencyRecordId: uuid("open_idempotency_record_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "cash_drawer_sessions_drawer_location_fk",
      columns: [table.drawerId, table.locationId],
      foreignColumns: [cashDrawers.id, cashDrawers.locationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "cash_drawer_sessions_open_idempotency_fk",
      columns: [table.openIdempotencyRecordId],
      foreignColumns: [idempotencyRecords.id],
    }).onDelete("restrict"),
    unique("cash_drawer_sessions_drawer_number_unique").on(table.drawerId, table.sessionNumber),
    uniqueIndex("cash_drawer_sessions_one_open_per_drawer")
      .on(table.drawerId)
      .where(sql`${table.status} = 'OPEN'`),
    check("cash_drawer_sessions_status_valid", sql`${table.status} IN ('OPEN', 'CLOSED')`),
    check("cash_drawer_sessions_float_non_negative", sql`${table.openingFloat} >= 0`),
    check(
      "cash_drawer_sessions_closed_fields",
      sql`(${table.status} = 'CLOSED') = (${table.closedAt} IS NOT NULL)
        AND (${table.closedAt} IS NULL) = (${table.closedByUserId} IS NULL)
        AND (${table.closedAt} IS NULL) = (${table.countedAmount} IS NULL)
        AND (${table.closedAt} IS NULL) = (${table.expectedAmount} IS NULL)
        AND (${table.expectedAmount} IS NULL) = (${table.variance} IS NULL)
        AND (${table.countedAmount} IS NULL OR ${table.countedAmount} >= 0)
        AND (${table.variance} IS NULL OR ${table.variance} = ${table.countedAmount} - ${table.expectedAmount})`,
    ),
    index("cash_drawer_sessions_location_date_idx").on(table.locationId, table.businessDate),
  ],
);

export const cashDrawerMovements = pgTable(
  "cash_drawer_movements",
  {
    id: uuidPrimaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => cashDrawerSessions.id, { onDelete: "restrict" }),
    movementType: text("movement_type").notNull(),
    amount: money("amount").notNull(),
    reason: text("reason").notNull(),
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    recordedAt: timestamptz("recorded_at").notNull(),
    idempotencyRecordId: uuid("idempotency_record_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "cash_drawer_movements_idempotency_fk",
      columns: [table.idempotencyRecordId],
      foreignColumns: [idempotencyRecords.id],
    }).onDelete("restrict"),
    check("cash_drawer_movements_type_valid", sql`${table.movementType} IN ('PAID_IN', 'PAID_OUT')`),
    check("cash_drawer_movements_amount_positive", sql`${table.amount} > 0`),
    check(
      "cash_drawer_movements_reason",
      sql`length(trim(${table.reason})) > 0 AND ${table.reason} !~ '[0-9]{13,}'`,
    ),
    uniqueIndex("cash_drawer_movements_idempotency_unique").on(table.idempotencyRecordId),
    index("cash_drawer_movements_session_idx").on(table.sessionId, table.recordedAt),
  ],
);
