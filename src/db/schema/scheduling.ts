import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  time,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { activeColumn, uuidPrimaryKey } from "../helpers/columns";
import {
  calendarDate,
  createdAt,
  timestamptz,
  updatedAt,
} from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { employees, positions } from "./employees";
import { locations, restaurantAreas } from "./organization";

// Overlapping published periods are refused by an exclusion constraint in migration
// 0005, because Drizzle can't express one. Foreign keys are named here whenever the
// generated name would pass PostgreSQL's 63-character limit.

/** Hours as a decimal string, such as "37.50". Not money or an inventory quantity. */
function hours(name: string) {
  return numeric(name, { precision: 6, scale: 2, mode: "string" });
}

export const schedulePeriods = pgTable(
  "schedule_periods",
  {
    id: uuidPrimaryKey(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    startDate: calendarDate("start_date").notNull(),
    endDate: calendarDate("end_date").notNull(),
    status: text("status").notNull().default("DRAFT"),
    publishedAt: timestamptz("published_at"),
    publishedByUserId: uuid("published_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    archivedAt: timestamptz("archived_at"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("schedule_periods_id_location_id_unique").on(
      table.id,
      table.locationId,
    ),
    check(
      "schedule_periods_status_valid",
      sql`${table.status} IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')`,
    ),
    check(
      "schedule_periods_date_range",
      sql`${table.startDate} <= ${table.endDate}`,
    ),
    check(
      "schedule_periods_published_metadata",
      sql`(${table.status} = 'DRAFT') = (${table.publishedAt} IS NULL) AND (${table.publishedAt} IS NULL) = (${table.publishedByUserId} IS NULL)`,
    ),
    check(
      "schedule_periods_archived_metadata",
      sql`(${table.status} = 'ARCHIVED') = (${table.archivedAt} IS NOT NULL)`,
    ),
    index("schedule_periods_location_id_start_date_idx").on(
      table.locationId,
      table.startDate,
    ),
  ],
);

/** Reusable staffing demand. It never names an employee. */
export const staffingTemplates = pgTable(
  "staffing_templates",
  {
    id: uuidPrimaryKey(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description"),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("staffing_templates_location_id_name_unique").on(
      table.locationId,
      table.name,
    ),
  ],
);

export const staffingTemplateRequirements = pgTable(
  "staffing_template_requirements",
  {
    id: uuidPrimaryKey(),
    staffingTemplateId: uuid("staffing_template_id").notNull(),
    dayOfWeek: integer("day_of_week").notNull(),
    positionId: uuid("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "restrict" }),
    restaurantAreaId: uuid("restaurant_area_id"),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    requiredEmployeeCount: integer("required_employee_count").notNull(),
    priority: integer("priority").notNull().default(0),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "staffing_template_requirements_template_fk",
      columns: [table.staffingTemplateId],
      foreignColumns: [staffingTemplates.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "staffing_template_requirements_area_fk",
      columns: [table.restaurantAreaId],
      foreignColumns: [restaurantAreas.id],
    }).onDelete("restrict"),
    check(
      "staffing_template_requirements_day_of_week_valid",
      sql`${table.dayOfWeek} BETWEEN 0 AND 6`,
    ),
    check(
      "staffing_template_requirements_count_positive",
      sql`${table.requiredEmployeeCount} > 0`,
    ),
    check(
      "staffing_template_requirements_times_differ",
      sql`${table.startTime} <> ${table.endTime}`,
    ),
    index("staffing_template_requirements_template_id_idx").on(
      table.staffingTemplateId,
    ),
  ],
);

/** A staffing requirement, not an assignment. `shift_date` is the local start date. */
export const shifts = pgTable(
  "shifts",
  {
    id: uuidPrimaryKey(),
    schedulePeriodId: uuid("schedule_period_id").notNull(),
    locationId: uuid("location_id").notNull(),
    positionId: uuid("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "restrict" }),
    restaurantAreaId: uuid("restaurant_area_id").references(
      () => restaurantAreas.id,
      { onDelete: "restrict" },
    ),
    shiftDate: calendarDate("shift_date").notNull(),
    startAt: timestamptz("start_at").notNull(),
    endAt: timestamptz("end_at").notNull(),
    requiredEmployeeCount: integer("required_employee_count")
      .notNull()
      .default(1),
    courseOrStationNote: text("course_or_station_note"),
    notes: text("notes"),
    priority: integer("priority").notNull().default(0),
    sourceRequirementId: uuid("source_requirement_id"),
    cancelledAt: timestamptz("cancelled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "shifts_period_location_fk",
      columns: [table.schedulePeriodId, table.locationId],
      foreignColumns: [schedulePeriods.id, schedulePeriods.locationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "shifts_source_requirement_fk",
      columns: [table.sourceRequirementId],
      foreignColumns: [staffingTemplateRequirements.id],
    }).onDelete("restrict"),
    unique("shifts_period_requirement_date_unique").on(
      table.schedulePeriodId,
      table.sourceRequirementId,
      table.shiftDate,
    ),
    check("shifts_end_after_start", sql`${table.endAt} > ${table.startAt}`),
    check(
      "shifts_required_count_positive",
      sql`${table.requiredEmployeeCount} > 0`,
    ),
    index("shifts_schedule_period_id_shift_date_idx").on(
      table.schedulePeriodId,
      table.shiftDate,
    ),
  ],
);

/** History of one generator execution. Written by the generator only. */
export const scheduleGenerationRuns = pgTable(
  "schedule_generation_runs",
  {
    id: uuidPrimaryKey(),
    schedulePeriodId: uuid("schedule_period_id").notNull(),
    startedByUserId: uuid("started_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    completedAt: timestamptz("completed_at"),
    generationMode: text("generation_mode").notNull(),
    status: text("status").notNull().default("STARTED"),
    rulesSnapshot: jsonb("rules_snapshot"),
    createdAssignmentCount: integer("created_assignment_count")
      .notNull()
      .default(0),
    unfilledShiftCount: integer("unfilled_shift_count").notNull().default(0),
    warningCount: integer("warning_count").notNull().default(0),
    unfilledDetails: jsonb("unfilled_details"),
    warnings: jsonb("warnings"),
    failureCode: text("failure_code"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "schedule_generation_runs_period_fk",
      columns: [table.schedulePeriodId],
      foreignColumns: [schedulePeriods.id],
    }).onDelete("restrict"),
    check(
      "schedule_generation_runs_mode_valid",
      sql`${table.generationMode} IN ('GENERATE_DRAFT', 'FILL_OPEN_SHIFTS')`,
    ),
    check(
      "schedule_generation_runs_status_valid",
      sql`${table.status} IN ('STARTED', 'COMPLETED', 'FAILED')`,
    ),
    index("schedule_generation_runs_schedule_period_id_idx").on(
      table.schedulePeriodId,
    ),
  ],
);

/** Rows are never deleted: a removed or swapped assignment keeps its history. */
export const shiftAssignments = pgTable(
  "shift_assignments",
  {
    id: uuidPrimaryKey(),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => shifts.id, { onDelete: "restrict" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    assignmentSource: text("assignment_source").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    assignedByUserId: uuid("assigned_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    assignedAt: timestamptz("assigned_at").notNull().defaultNow(),
    notes: text("notes"),
    generationRunId: uuid("generation_run_id"),
    generationRationale: jsonb("generation_rationale"),
    endedAt: timestamptz("ended_at"),
    endedByUserId: uuid("ended_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "shift_assignments_generation_run_fk",
      columns: [table.generationRunId],
      foreignColumns: [scheduleGenerationRuns.id],
    }).onDelete("restrict"),
    check(
      "shift_assignments_source_valid",
      sql`${table.assignmentSource} IN ('MANUAL', 'GENERATED', 'SHIFT_SWAP')`,
    ),
    check(
      "shift_assignments_status_valid",
      sql`${table.status} IN ('ACTIVE', 'REMOVED', 'SWAPPED')`,
    ),
    check(
      "shift_assignments_ended_matches_status",
      sql`(${table.status} = 'ACTIVE') = (${table.endedAt} IS NULL)`,
    ),
    uniqueIndex("shift_assignments_one_active_per_employee_unique")
      .on(table.shiftId, table.employeeId)
      .where(sql`${table.status} = 'ACTIVE'`),
    index("shift_assignments_employee_id_status_idx").on(
      table.employeeId,
      table.status,
    ),
    index("shift_assignments_shift_id_status_idx").on(
      table.shiftId,
      table.status,
    ),
  ],
);

/**
 * Whether someone can work, as opposed to a preference. A null `location_id` applies
 * everywhere. An `end_time` at or before `start_time` runs past midnight, so 00:00 to
 * 00:00 is the whole day. Day 0 is Sunday.
 */
export const employeeAvailability = pgTable(
  "employee_availability",
  {
    id: uuidPrimaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, {
      onDelete: "restrict",
    }),
    dayOfWeek: integer("day_of_week").notNull(),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    availabilityType: text("availability_type").notNull(),
    effectiveFrom: calendarDate("effective_from").notNull(),
    effectiveTo: calendarDate("effective_to"),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    check(
      "employee_availability_day_of_week_valid",
      sql`${table.dayOfWeek} BETWEEN 0 AND 6`,
    ),
    check(
      "employee_availability_type_valid",
      sql`${table.availabilityType} IN ('AVAILABLE', 'UNAVAILABLE')`,
    ),
    check(
      "employee_availability_effective_range",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveFrom} <= ${table.effectiveTo}`,
    ),
    index("employee_availability_employee_id_idx").on(table.employeeId),
  ],
);

/** Overrides recurring availability. Null times mean the whole date. */
export const employeeAvailabilityExceptions = pgTable(
  "employee_availability_exceptions",
  {
    id: uuidPrimaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, {
      onDelete: "restrict",
    }),
    exceptionDate: calendarDate("exception_date").notNull(),
    startTime: time("start_time"),
    endTime: time("end_time"),
    availabilityType: text("availability_type").notNull(),
    reason: text("reason"),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    check(
      "employee_availability_exceptions_type_valid",
      sql`${table.availabilityType} IN ('AVAILABLE', 'UNAVAILABLE')`,
    ),
    check(
      "employee_availability_exceptions_times_paired",
      sql`(${table.startTime} IS NULL) = (${table.endTime} IS NULL)`,
    ),
    index("employee_availability_exceptions_employee_id_date_idx").on(
      table.employeeId,
      table.exceptionDate,
    ),
  ],
);

/** What someone would like. Soft criteria only, never a reason they can't work. */
export const employeeSchedulingPreferences = pgTable(
  "employee_scheduling_preferences",
  {
    id: uuidPrimaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, {
      onDelete: "restrict",
    }),
    targetHoursPerWeek: hours("target_hours_per_week"),
    minimumHoursPerWeek: hours("minimum_hours_per_week"),
    maximumHoursPerWeek: hours("maximum_hours_per_week"),
    maximumDaysPerWeek: integer("maximum_days_per_week"),
    maximumConsecutiveDays: integer("maximum_consecutive_days"),
    preferredShiftStart: time("preferred_shift_start"),
    preferredShiftEnd: time("preferred_shift_end"),
    preferWeekends: boolean("prefer_weekends"),
    preferOpening: boolean("prefer_opening"),
    preferClosing: boolean("prefer_closing"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("employee_scheduling_preferences_employee_location_unique")
      .on(table.employeeId, table.locationId)
      .nullsNotDistinct(),
    check(
      "employee_scheduling_preferences_hours_order",
      sql`${table.minimumHoursPerWeek} IS NULL OR ${table.maximumHoursPerWeek} IS NULL OR ${table.minimumHoursPerWeek} <= ${table.maximumHoursPerWeek}`,
    ),
    check(
      "employee_scheduling_preferences_day_limits_valid",
      sql`(${table.maximumDaysPerWeek} IS NULL OR ${table.maximumDaysPerWeek} BETWEEN 1 AND 7) AND (${table.maximumConsecutiveDays} IS NULL OR ${table.maximumConsecutiveDays} > 0)`,
    ),
    check(
      "employee_scheduling_preferences_window_paired",
      sql`(${table.preferredShiftStart} IS NULL) = (${table.preferredShiftEnd} IS NULL)`,
    ),
  ],
);

export const timeOffRequests = pgTable(
  "time_off_requests",
  {
    id: uuidPrimaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    startAt: timestamptz("start_at").notNull(),
    endAt: timestamptz("end_at").notNull(),
    requestType: text("request_type").notNull(),
    status: text("status").notNull().default("PENDING"),
    reason: text("reason"),
    employeeNote: text("employee_note"),
    managerNote: text("manager_note"),
    requestedAt: timestamptz("requested_at").notNull().defaultNow(),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    reviewedAt: timestamptz("reviewed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    check(
      "time_off_requests_end_after_start",
      sql`${table.endAt} > ${table.startAt}`,
    ),
    check(
      "time_off_requests_type_valid",
      sql`${table.requestType} IN ('VACATION', 'SICK', 'PERSONAL', 'OTHER')`,
    ),
    check(
      "time_off_requests_status_valid",
      sql`${table.status} IN ('PENDING', 'APPROVED', 'DENIED', 'CANCELLED')`,
    ),
    check(
      "time_off_requests_review_metadata",
      sql`(${table.reviewedAt} IS NULL) = (${table.reviewedByUserId} IS NULL)`,
    ),
    index("time_off_requests_employee_id_start_at_idx").on(
      table.employeeId,
      table.startAt,
    ),
    index("time_off_requests_status_idx").on(table.status),
  ],
);

/** Completing a swap ends the original assignment and creates a SHIFT_SWAP one. */
export const shiftSwapRequests = pgTable(
  "shift_swap_requests",
  {
    id: uuidPrimaryKey(),
    shiftAssignmentId: uuid("shift_assignment_id").notNull(),
    requestingEmployeeId: uuid("requesting_employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    targetEmployeeId: uuid("target_employee_id").references(() => employees.id, {
      onDelete: "restrict",
    }),
    status: text("status").notNull().default("PENDING"),
    reason: text("reason"),
    requestedAt: timestamptz("requested_at").notNull().defaultNow(),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    acceptedAt: timestamptz("accepted_at"),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    approvedAt: timestamptz("approved_at"),
    deniedByUserId: uuid("denied_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    deniedAt: timestamptz("denied_at"),
    replacementAssignmentId: uuid("replacement_assignment_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    foreignKey({
      name: "shift_swap_requests_assignment_fk",
      columns: [table.shiftAssignmentId],
      foreignColumns: [shiftAssignments.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "shift_swap_requests_replacement_fk",
      columns: [table.replacementAssignmentId],
      foreignColumns: [shiftAssignments.id],
    }).onDelete("restrict"),
    check(
      "shift_swap_requests_status_valid",
      sql`${table.status} IN ('PENDING', 'ACCEPTED', 'DENIED', 'CANCELLED', 'COMPLETED')`,
    ),
    check(
      "shift_swap_requests_target_differs",
      sql`${table.targetEmployeeId} IS NULL OR ${table.targetEmployeeId} <> ${table.requestingEmployeeId}`,
    ),
    check(
      "shift_swap_requests_completed_metadata",
      sql`(${table.status} = 'COMPLETED') = (${table.replacementAssignmentId} IS NOT NULL)`,
    ),
    uniqueIndex("shift_swap_requests_one_open_per_assignment_unique")
      .on(table.shiftAssignmentId)
      .where(sql`${table.status} IN ('PENDING', 'ACCEPTED')`),
    index("shift_swap_requests_status_idx").on(table.status),
  ],
);

/**
 * One row per location. A limit marked hard disqualifies a candidate, and otherwise it
 * only affects scores and warnings. `maximum_weekly_hours` is always hard when set.
 * These are business configuration, not a claim of labor-law compliance.
 */
export const schedulingRules = pgTable(
  "scheduling_rules",
  {
    id: uuidPrimaryKey(),
    locationId: uuid("location_id")
      .notNull()
      .unique()
      .references(() => locations.id, { onDelete: "restrict" }),
    avoidOvertime: boolean("avoid_overtime").notNull().default(true),
    weeklyOvertimeThreshold: hours("weekly_overtime_threshold")
      .notNull()
      .default("40.00"),
    minimumRestHours: hours("minimum_rest_hours"),
    minimumRestHard: boolean("minimum_rest_hard").notNull().default(false),
    maximumDaysPerWeek: integer("maximum_days_per_week"),
    maximumDaysHard: boolean("maximum_days_hard").notNull().default(false),
    maximumConsecutiveDays: integer("maximum_consecutive_days"),
    maximumConsecutiveHard: boolean("maximum_consecutive_hard")
      .notNull()
      .default(false),
    maximumWeeklyHours: hours("maximum_weekly_hours"),
    balanceWeekendShifts: boolean("balance_weekend_shifts")
      .notNull()
      .default(true),
    balanceClosingShifts: boolean("balance_closing_shifts")
      .notNull()
      .default(true),
    preferTargetHours: boolean("prefer_target_hours").notNull().default(true),
    weekStartDay: integer("week_start_day").notNull().default(1),
    /** Phase 18: worked overtime hours are costed at the hourly rate times this. */
    overtimeMultiplier: numeric("overtime_multiplier", { precision: 4, scale: 2, mode: "string" })
      .notNull()
      .default("1.50"),
    /** Phase 18: a clock-in later than this after the shift start is flagged late. */
    lateClockInGraceMinutes: integer("late_clock_in_grace_minutes").notNull().default(5),
    /**
     * Phase 20 (policy 19, D18): hours past this on one business date are overtime. Null is
     * off. Weekly overtime then counts only the hours that weren't daily overtime.
     */
    dailyOvertimeThreshold: hours("daily_overtime_threshold"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    check(
      "scheduling_rules_week_start_day_valid",
      sql`${table.weekStartDay} BETWEEN 0 AND 6`,
    ),
    check(
      "scheduling_rules_overtime_multiplier_valid",
      sql`${table.overtimeMultiplier} BETWEEN 1.00 AND 3.00`,
    ),
    check(
      "scheduling_rules_daily_overtime_valid",
      sql`${table.dailyOvertimeThreshold} IS NULL OR (${table.dailyOvertimeThreshold} > 0 AND ${table.dailyOvertimeThreshold} <= 24)`,
    ),
    check(
      "scheduling_rules_late_grace_valid",
      sql`${table.lateClockInGraceMinutes} BETWEEN 0 AND 120`,
    ),
    check(
      "scheduling_rules_day_limits_valid",
      sql`(${table.maximumDaysPerWeek} IS NULL OR ${table.maximumDaysPerWeek} BETWEEN 1 AND 7) AND (${table.maximumConsecutiveDays} IS NULL OR ${table.maximumConsecutiveDays} > 0)`,
    ),
    check(
      "scheduling_rules_hard_limits_have_values",
      sql`(NOT ${table.minimumRestHard} OR ${table.minimumRestHours} IS NOT NULL) AND (NOT ${table.maximumDaysHard} OR ${table.maximumDaysPerWeek} IS NOT NULL) AND (NOT ${table.maximumConsecutiveHard} OR ${table.maximumConsecutiveDays} IS NOT NULL)`,
    ),
  ],
);
