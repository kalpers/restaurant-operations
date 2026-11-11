import { z } from "zod";

import { AVAILABILITY_TYPES, GENERATION_MODES, TIME_OFF_TYPES } from "../types";

// Shape only. Business rules are in the services and PostgreSQL has the final word.

const expectedVersion = z.int().positive();
const date = z.iso.date();
/** "17:00" or "17:00:00", as the browser's time input and PostgreSQL produce. */
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/);
const optionalTime = time.nullable().default(null);
const day = z.int().min(0).max(6);

const requiredText = (max: number) => z.string().trim().min(1).max(max);

/** Blank becomes null, so "no value" has one representation. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((value) => (value === "" ? null : value));

/** A form's blank select or empty value arrives as null. */
const optionalUuid = z.uuid().nullable().default(null);

/** A decimal string, never coerced to a number. The services check its scale. */
const optionalHours = z.string().trim().max(16).nullable().default(null);
const optionalCount = z.int().positive().max(1000).nullable().default(null);
/** A three-way preference: yes, no, or no preference. Forms send it as text. */
const optionalFlag = z
  .union([
    z.boolean(),
    z.enum(["true", "false"]).transform((value) => value === "true"),
  ])
  .nullable()
  .default(null);

export const periodIdParamsSchema = z.object({ periodId: z.uuid() });
export const shiftIdParamsSchema = z.object({ shiftId: z.uuid() });
export const assignmentIdParamsSchema = z.object({ assignmentId: z.uuid() });
export const employeeIdParamsSchema = z.object({ employeeId: z.uuid() });
export const recordParamsSchema = z.object({
  employeeId: z.uuid(),
  recordId: z.uuid(),
});
export const ownRecordParamsSchema = z.object({ recordId: z.uuid() });
export const requestIdParamsSchema = z.object({ requestId: z.uuid() });
export const swapIdParamsSchema = z.object({ swapId: z.uuid() });
export const templateIdParamsSchema = z.object({ templateId: z.uuid() });
export const requirementParamsSchema = z.object({
  templateId: z.uuid(),
  requirementId: z.uuid(),
});

export const expectedVersionSchema = z.object({ expectedVersion });

export const createPeriodSchema = z.object({
  name: requiredText(200),
  startDate: date,
  endDate: date,
});

export const updatePeriodSchema = createPeriodSchema.extend({ expectedVersion });

const shiftFields = {
  positionId: z.uuid(),
  restaurantAreaId: optionalUuid,
  shiftDate: date,
  startTime: time,
  endTime: time,
  requiredEmployeeCount: z.int().positive().max(100).default(1),
  courseOrStationNote: optionalText(200),
  notes: optionalText(1000),
  priority: z.int().min(-1000).max(1000).default(0),
};

export const createShiftSchema = z.object({
  ...shiftFields,
  expectedPeriodVersion: expectedVersion,
});

export const updateShiftSchema = z.object({
  ...shiftFields,
  expectedVersion,
  expectedPeriodVersion: expectedVersion,
});

export const shiftVersionsSchema = z.object({
  expectedVersion,
  expectedPeriodVersion: expectedVersion,
});

export const assignEmployeeSchema = z.object({
  employeeId: z.uuid(),
  notes: optionalText(1000),
  expectedPeriodVersion: expectedVersion,
});

export const periodVersionSchema = z.object({
  expectedPeriodVersion: expectedVersion,
});

export const generateSchema = z.object({
  mode: z.enum(GENERATION_MODES),
  expectedVersion,
});

export const applyTemplateSchema = z.object({
  templateId: z.uuid(),
  expectedPeriodVersion: expectedVersion,
});

export const recurringAvailabilitySchema = z.object({
  dayOfWeek: z.coerce.number().pipe(day),
  startTime: time,
  endTime: time,
  availabilityType: z.enum(AVAILABILITY_TYPES),
  effectiveFrom: date,
  effectiveTo: date.nullable().default(null),
  thisLocationOnly: z.boolean().default(false),
});

export const updateRecurringAvailabilitySchema =
  recurringAvailabilitySchema.extend({ expectedVersion });

export const availabilityExceptionSchema = z.object({
  exceptionDate: date,
  startTime: optionalTime,
  endTime: optionalTime,
  availabilityType: z.enum(AVAILABILITY_TYPES),
  reason: optionalText(500),
  thisLocationOnly: z.boolean().default(false),
});

export const preferencesSchema = z.object({
  targetHoursPerWeek: optionalHours,
  minimumHoursPerWeek: optionalHours,
  maximumHoursPerWeek: optionalHours,
  maximumDaysPerWeek: optionalCount,
  maximumConsecutiveDays: optionalCount,
  preferredShiftStart: optionalTime,
  preferredShiftEnd: optionalTime,
  preferWeekends: optionalFlag,
  preferOpening: optionalFlag,
  preferClosing: optionalFlag,
  expectedVersion: expectedVersion.nullable(),
});

export const timeOffRequestSchema = z.object({
  startDate: date,
  startTime: optionalTime,
  endDate: date,
  endTime: optionalTime,
  requestType: z.enum(TIME_OFF_TYPES),
  reason: optionalText(1000),
  employeeNote: optionalText(1000),
});

export const managerTimeOffSchema = timeOffRequestSchema.extend({
  employeeId: z.uuid(),
});

export const timeOffReviewSchema = z.object({
  managerNote: optionalText(1000),
  expectedVersion,
});

export const swapRequestSchema = z.object({
  assignmentId: z.uuid(),
  targetEmployeeId: optionalUuid,
  reason: optionalText(1000),
});

export const swapTargetSchema = z.object({
  targetEmployeeId: z.uuid(),
  expectedVersion,
});

export const createTemplateSchema = z.object({
  name: requiredText(200),
  description: optionalText(1000),
});

export const updateTemplateSchema = createTemplateSchema.extend({
  active: z.boolean(),
  expectedVersion,
});

export const requirementSchema = z.object({
  dayOfWeek: z.coerce.number().pipe(day),
  positionId: z.uuid(),
  restaurantAreaId: optionalUuid,
  startTime: time,
  endTime: time,
  requiredEmployeeCount: z.int().positive().max(100),
  priority: z.int().min(-1000).max(1000).nullable().default(0).transform((value) => value ?? 0),
});

export const rulesSchema = z.object({
  avoidOvertime: z.boolean(),
  weeklyOvertimeThreshold: z.string().trim().min(1).max(16),
  minimumRestHours: optionalHours,
  minimumRestHard: z.boolean(),
  maximumDaysPerWeek: z.int().min(1).max(7).nullable().default(null),
  maximumDaysHard: z.boolean(),
  maximumConsecutiveDays: optionalCount,
  maximumConsecutiveHard: z.boolean(),
  maximumWeeklyHours: optionalHours,
  balanceWeekendShifts: z.boolean(),
  balanceClosingShifts: z.boolean(),
  preferTargetHours: z.boolean(),
  weekStartDay: z.coerce.number().pipe(day),
  overtimeMultiplier: z
    .string()
    .trim()
    .regex(/^\d(\.\d{1,2})?$/, "Enter a multiplier such as 1.50.")
    .default("1.50"),
  lateClockInGraceMinutes: z.coerce.number().int().min(0).max(120).default(5),
  expectedVersion: expectedVersion.nullable(),
});

/** The day timeline's query string. Drafts are included unless turned off. */
export const timelineQuerySchema = z.object({
  date,
  includeDrafts: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});
