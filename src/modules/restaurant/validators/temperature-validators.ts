import { z } from "zod";

import { TEMPERATURE_POINT_KINDS, TEMPERATURE_UNITS } from "@/db/schema/food-safety";
import { IDEMPOTENCY_KEY_PATTERN } from "@/infrastructure/idempotency/idempotency-service";

// Phase 36 part 2 shape only. Business rules are in the temperature service, and PostgreSQL has
// the final word.

const temperature = z.string().trim().max(8);
const optionalTemperature = temperature.nullable().default(null);

const pointFields = {
  name: z.string().trim().min(1).max(80),
  kind: z.enum(TEMPERATURE_POINT_KINDS),
  minimumValue: optionalTemperature,
  maximumValue: optionalTemperature,
  checkIntervalMinutes: z.int().min(30).max(1440).nullable().default(null),
  sortOrder: z.int().min(0).max(10000).default(0),
};

export const createTemperaturePointSchema = z.object({ ...pointFields, unit: z.enum(TEMPERATURE_UNITS).nullable().optional() });

export const updateTemperaturePointSchema = z.object({ ...pointFields, active: z.boolean(), expectedVersion: z.int().positive() });

export const temperaturePointIdParamsSchema = z.object({ pointId: z.uuid() });

export const recordTemperatureReadingSchema = z.object({
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN),
  pointId: z.uuid(),
  value: temperature.min(1),
  correctiveAction: z.string().max(500).nullable().optional(),
  followsUpReadingId: z.uuid().nullable().optional(),
  correctsReadingId: z.uuid().nullable().optional(),
});

export const temperatureLogQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  pointId: z.uuid().optional(),
  outOfRangeOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});
