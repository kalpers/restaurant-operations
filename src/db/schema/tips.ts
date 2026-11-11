import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, numeric, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { activeColumn, uuidPrimaryKey } from "../helpers/columns";
import { money } from "../helpers/numeric";
import { businessDate, createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { employees, positions } from "./employees";
import { idempotencyRecords } from "./infrastructure";
import { locations, organizations } from "./organization";

// Phase 18 tip pools, owned by Settlements (approved policies D21-D27). Record only: a
// finalized distribution says how a business date's tips are shared; nothing pays them out.
// Lines snapshot the hours and points used, so a later rule change never changes a
// finalized distribution (rule 4). Append-only triggers are in migration 0036.

/** Worked or weighted hours to 4 places. Not money. */
function hours(name: string) {
  return numeric(name, { precision: 10, scale: 4, mode: "string" });
}

export const tipPoolRules = pgTable(
  "tip_pool_rules",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull().unique(),
    name: text("name"),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "tip_pool_rules_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    check("tip_pool_rules_name", sql`${table.name} IS NULL OR length(trim(${table.name})) > 0`),
  ],
);

/** A participating Position and its points. Removed positions are deactivated, not deleted. */
export const tipPoolRulePositions = pgTable(
  "tip_pool_rule_positions",
  {
    id: uuidPrimaryKey(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => tipPoolRules.id, { onDelete: "restrict" }),
    positionId: uuid("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "restrict" }),
    points: numeric("points", { precision: 6, scale: 2, mode: "string" }).notNull(),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("tip_pool_rule_positions_rule_position_unique").on(table.ruleId, table.positionId),
    check("tip_pool_rule_positions_points_positive", sql`${table.points} > 0`),
  ],
);

export const tipDistributions = pgTable(
  "tip_distributions",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull(),
    businessDate: businessDate().notNull(),
    status: text("status").notNull().default("FINALIZED"),
    poolTotal: money("pool_total").notNull(),
    cashTips: money("cash_tips").notNull(),
    cardTips: money("card_tips").notNull(),
    totalWeightedHours: hours("total_weighted_hours").notNull(),
    ruleSnapshot: jsonb("rule_snapshot").notNull(),
    finalizedByUserId: uuid("finalized_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    finalizedAt: timestamptz("finalized_at").notNull(),
    idempotencyRecordId: uuid("idempotency_record_id").notNull(),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    voidedAt: timestamptz("voided_at"),
    voidReason: text("void_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "tip_distributions_location_org_fk",
      columns: [table.locationId, table.organizationId],
      foreignColumns: [locations.id, locations.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "tip_distributions_idempotency_fk",
      columns: [table.idempotencyRecordId],
      foreignColumns: [idempotencyRecords.id],
    }).onDelete("restrict"),
    uniqueIndex("tip_distributions_idempotency_unique").on(table.idempotencyRecordId),
    uniqueIndex("tip_distributions_one_finalized_per_date")
      .on(table.locationId, table.businessDate)
      .where(sql`${table.status} = 'FINALIZED'`),
    check("tip_distributions_status_valid", sql`${table.status} IN ('FINALIZED', 'VOIDED')`),
    check(
      "tip_distributions_amounts",
      sql`${table.cashTips} >= 0 AND ${table.cardTips} >= 0
        AND ${table.poolTotal} = ${table.cashTips} + ${table.cardTips}
        AND ${table.totalWeightedHours} >= 0`,
    ),
    check(
      "tip_distributions_void_fields",
      sql`(${table.status} = 'VOIDED') = (${table.voidedAt} IS NOT NULL)
        AND (${table.voidedAt} IS NULL) = (${table.voidedByUserId} IS NULL)
        AND (${table.voidedAt} IS NULL) = (${table.voidReason} IS NULL)
        AND (${table.voidReason} IS NULL OR (length(trim(${table.voidReason})) > 0 AND ${table.voidReason} !~ '[0-9]{13,}'))`,
    ),
    index("tip_distributions_location_date_idx").on(table.locationId, table.businessDate),
  ],
);

export const tipDistributionLines = pgTable(
  "tip_distribution_lines",
  {
    id: uuidPrimaryKey(),
    distributionId: uuid("distribution_id")
      .notNull()
      .references(() => tipDistributions.id, { onDelete: "restrict" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    positionId: uuid("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "restrict" }),
    positionCodeSnapshot: text("position_code_snapshot").notNull(),
    workedHours: hours("worked_hours").notNull(),
    points: numeric("points", { precision: 6, scale: 2, mode: "string" }).notNull(),
    weightedHours: hours("weighted_hours").notNull(),
    share: money("share").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("tip_distribution_lines_employee_position_unique").on(
      table.distributionId,
      table.employeeId,
      table.positionId,
    ),
    check(
      "tip_distribution_lines_values",
      sql`${table.workedHours} > 0 AND ${table.points} > 0 AND ${table.weightedHours} > 0 AND ${table.share} >= 0`,
    ),
    index("tip_distribution_lines_employee_idx").on(table.employeeId),
  ],
);
