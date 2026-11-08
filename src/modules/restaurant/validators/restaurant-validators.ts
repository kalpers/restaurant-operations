import { z } from "zod";

import { TABLE_CONDITIONS } from "../types";

// Shape only. Business rules are in the services and PostgreSQL has the final word.

const expectedVersion = z.int().positive();
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

const optionalReason = optionalText(500);

/** A stable operational identity. Combinations are relational, never "10+11". */
const tableNumber = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/);
const sectionCode = z
  .string()
  .trim()
  .regex(/^[A-Z0-9][A-Z0-9_]{0,39}$/);
const capacity = z.int().min(1).max(500);
const tableIds = z.array(z.uuid()).min(1).max(30);

export const expectedVersionSchema = z.object({ expectedVersion });

export const tableIdParamsSchema = z.object({ tableId: z.uuid() });
export const sessionIdParamsSchema = z.object({ sessionId: z.uuid() });
export const sessionTableParamsSchema = z.object({
  sessionId: z.uuid(),
  tableId: z.uuid(),
});
export const sectionIdParamsSchema = z.object({ sectionId: z.uuid() });
export const assignmentIdParamsSchema = z.object({ assignmentId: z.uuid() });

export const createTableSchema = z.object({
  restaurantAreaId: z.uuid(),
  tableNumber,
  name: optionalText(100),
  capacity,
  minimumCapacity: capacity.nullable().default(null),
  sortOrder: z.int().min(0).max(100000).nullable().default(null),
});

export const updateTableSchema = createTableSchema.extend({
  active: z.boolean(),
  expectedVersion,
});

export const changeConditionSchema = z.object({
  condition: z.enum(TABLE_CONDITIONS),
  reason: optionalReason,
  expectedVersion,
});

export const seatPartySchema = z.object({
  tableIds,
  partySize: capacity,
  /** Left out, it uses the section's server. Null seats the party with no server. */
  serverEmployeeId: z.uuid().nullable().optional(),
  capacityOverrideReason: optionalReason,
  scheduleOverrideReason: optionalReason,
  /** For a table held for another party's reservation. Needs the override permission. */
  holdOverrideReason: optionalReason,
  notes: optionalText(500),
});

export const moveSessionSchema = z.object({
  tableIds,
  capacityOverrideReason: optionalReason,
  expectedVersion,
});

export const addSessionTableSchema = z.object({
  tableId: z.uuid(),
  capacityOverrideReason: optionalReason,
  expectedVersion,
});

export const removeSessionTableSchema = z.object({
  capacityOverrideReason: optionalReason,
  expectedVersion,
});

export const assignSessionServerSchema = z.object({
  serverEmployeeId: z.uuid().nullable(),
  scheduleOverrideReason: optionalReason,
  expectedVersion,
});

export const cancelSessionSchema = z.object({
  reason: requiredText(500),
  expectedVersion,
});

export const serverCandidatesQuerySchema = z.object({
  areaId: z.uuid(),
});

export const createSectionSchema = z.object({
  code: sectionCode,
  name: requiredText(100),
  restaurantAreaId: z.uuid().nullable().default(null),
});

export const updateSectionSchema = z.object({
  name: requiredText(100),
  restaurantAreaId: z.uuid().nullable().default(null),
  active: z.boolean(),
  expectedVersion,
});

export const setSectionTablesSchema = z.object({
  tableIds: z.array(z.uuid()).max(200),
  expectedVersion,
});

export const assignSectionServerSchema = z.object({
  employeeId: z.uuid(),
  scheduleOverrideReason: optionalReason,
});
