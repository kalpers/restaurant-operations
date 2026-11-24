import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { readConstraintName } from "@/db/helpers/database-errors";
import { locationSettings, notifications, temperaturePoints, temperatureReadings } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { readLocationClock } from "@/modules/restaurant/services/access";
import {
  createTemperaturePoint,
  exportTemperatureLogCsv,
  listChecksDue,
  listTemperaturePoints,
  listTemperatureReadings,
  recordTemperatureReading,
  updateTemperaturePoint,
  type PointInput,
} from "@/modules/restaurant/services/temperature-service";
import { AppError } from "@/shared/errors/app-error";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import { createLinkedEmployee, createSchedulingScenario, type SchedulingScenario } from "../../fixtures/scheduling-fixtures";

const database = () => getDatabase();
const key = () => `temp-${randomUUID()}`;

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) {
      return error.code;
    }

    return readConstraintName(error) ?? (error as Error).message;
  }

  return undefined;
}

describe("temperature logs (Phase 36 part 2)", () => {
  let scenario: SchedulingScenario;
  let manager: Actor;
  let cook: Actor;
  let today: string;

  beforeEach(async () => {
    await clearEmployeeData(database());
    scenario = await createSchedulingScenario(database());
    manager = await actorWith(database(), scenario, ["food-safety.view", "food-safety.record", "food-safety.manage", "reports.export"]);
    ({ actor: cook } = await createLinkedEmployee(database(), scenario, ["food-safety.view", "food-safety.record"], { positionId: scenario.server }));
    today = (await readLocationClock(database(), scenario.locationA, new Date())).businessDate;
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  const walkIn = (input: Partial<PointInput> = {}) =>
    createTemperaturePoint(database(), manager, {
      name: "Walk-in cooler",
      kind: "COLD_HOLDING",
      minimumValue: "33",
      maximumValue: "41",
      checkIntervalMinutes: 240,
      sortOrder: 10,
      ...input,
    });

  it("fixes each point's unit when created, from the location's setting by default", async () => {
    const fahrenheit = await walkIn();

    await database().update(locationSettings).set({ temperatureUnit: "C" }).where(eq(locationSettings.locationId, scenario.locationA));

    const celsius = await walkIn({ name: "Freezer", kind: "FROZEN", minimumValue: null, maximumValue: "-18" });

    expect(fahrenheit).toMatchObject({ unit: "F", minimumValue: "33.0", maximumValue: "41.0", rangeText: "33.0–41.0 °F" });
    expect(celsius).toMatchObject({ unit: "C", rangeText: "at most -18.0 °C" });
    expect(await codeOf(walkIn({ minimumValue: "45", maximumValue: "41" }))).toBe("INVALID_RANGE");
  });

  it("records an in-range reading with the point's range copied onto it", async () => {
    const point = await walkIn();
    const recorded = await recordTemperatureReading(database(), cook, { idempotencyKey: key(), pointId: point.id, value: "38.5" });

    expect(recorded).toMatchObject({ inRange: true, businessDate: today, replayed: false });

    // Changing the point later never changes the reading.
    await updateTemperaturePoint(database(), manager, point.id, {
      name: "Walk-in",
      kind: "COLD_HOLDING",
      minimumValue: "35",
      maximumValue: "38",
      checkIntervalMinutes: 240,
      sortOrder: 10,
      active: true,
      expectedVersion: point.version,
    });

    const [reading] = await listTemperatureReadings(database(), manager, { from: today, to: today });

    expect(reading).toMatchObject({ pointName: "Walk-in cooler", value: "38.5", rangeText: "33.0–41.0 °F", inRange: true });
    expect(reading!.recordedByName).not.toBeNull();
  });

  it("needs a corrective action out of range and notifies managers once, even on retry", async () => {
    const point = await walkIn();
    const idempotencyKey = key();

    expect(await codeOf(recordTemperatureReading(database(), cook, { idempotencyKey, pointId: point.id, value: "47" }))).toBe(
      "CORRECTIVE_ACTION_REQUIRED",
    );

    const input = { idempotencyKey, pointId: point.id, value: "47", correctiveAction: "Door left open; moved stock to reach-in" };
    const first = await recordTemperatureReading(database(), cook, input);
    const second = await recordTemperatureReading(database(), cook, input);

    expect(first).toMatchObject({ inRange: false, replayed: false });
    expect(second).toMatchObject({ id: first.id, replayed: true });
    expect(await database().select().from(temperatureReadings)).toHaveLength(1);

    const sent = await database().select().from(notifications).where(eq(notifications.temperatureReadingId, first.id));

    // One each for the manager and the scenario's owner (both hold food-safety.manage), not the cook.
    const recipients = sent.map((row) => row.recipientUserId);

    expect(recipients).toContain(manager.userId);
    expect(recipients).not.toContain(cook.userId);
    expect(new Set(recipients).size).toBe(recipients.length);
    expect(sent[0]).toMatchObject({ notificationType: "TEMPERATURE_OUT_OF_RANGE", title: "Walk-in cooler is out of range" });
    expect(sent[0]!.body).toContain("47.0 °F");
  });

  it("keeps readings append-only, with corrections and rechecks as new readings", async () => {
    const point = await walkIn();
    const wrong = await recordTemperatureReading(database(), cook, { idempotencyKey: key(), pointId: point.id, value: "84", correctiveAction: "Recheck" });
    const fixed = await recordTemperatureReading(database(), cook, {
      idempotencyKey: key(),
      pointId: point.id,
      value: "38",
      correctsReadingId: wrong.id,
    });
    const recheck = await recordTemperatureReading(database(), cook, {
      idempotencyKey: key(),
      pointId: point.id,
      value: "39",
      followsUpReadingId: wrong.id,
    });
    const readings = new Map((await listTemperatureReadings(database(), manager, { from: today, to: today })).map((row) => [row.id, row]));

    expect(readings.get(wrong.id)!.correctedByReadingId).toBe(fixed.id);
    expect(readings.get(recheck.id)!.followsUpReadingId).toBe(wrong.id);

    expect(await codeOf(database().update(temperatureReadings).set({ value: "40" }).where(eq(temperatureReadings.id, wrong.id)))).toBe(
      "temperature_readings_append_only",
    );
    expect(
      await codeOf(database().update(temperatureReadings).set({ correctiveAction: "Changed" }).where(eq(temperatureReadings.id, wrong.id))),
    ).toBe("temperature_readings_append_only");
    expect(await codeOf(database().delete(temperatureReadings).where(eq(temperatureReadings.id, wrong.id)))).toBe(
      "temperature_readings_append_only",
    );
    expect(await codeOf(database().delete(temperaturePoints).where(eq(temperaturePoints.id, point.id)))).toBe("temperature_points_no_delete");

    // The database refuses an in-range flag that doesn't match the range.
    expect(
      await codeOf(
        database().insert(temperatureReadings).values({
          organizationId: scenario.organizationId,
          locationId: scenario.locationA,
          pointId: point.id,
          pointNameSnapshot: "X",
          value: "50.0",
          unit: "F",
          minimumValue: "33.0",
          maximumValue: "41.0",
          inRange: true,
          takenAt: new Date(),
          businessDate: today,
          recordedByUserId: cook.userId,
        }),
      ),
    ).toBe("temperature_readings_in_range_matches");
  });

  it("refuses a reading at an inactive point, another location's reading, and card numbers", async () => {
    const point = await walkIn();
    const reading = await recordTemperatureReading(database(), cook, { idempotencyKey: key(), pointId: point.id, value: "38" });
    const atB = await actorWith(database(), scenario, ["food-safety.view", "food-safety.record", "food-safety.manage"], scenario.locationB);
    const pointB = await createTemperaturePoint(database(), atB, {
      name: "B cooler",
      kind: "COLD_HOLDING",
      minimumValue: null,
      maximumValue: "41",
      checkIntervalMinutes: null,
      sortOrder: 0,
    });

    expect(
      await codeOf(recordTemperatureReading(database(), atB, { idempotencyKey: key(), pointId: pointB.id, value: "38", correctsReadingId: reading.id })),
    ).toBe("NOT_FOUND");
    expect(await codeOf(recordTemperatureReading(database(), cook, { idempotencyKey: key(), pointId: pointB.id, value: "38" }))).toBe("NOT_FOUND");
    expect(
      await codeOf(
        recordTemperatureReading(database(), cook, { idempotencyKey: key(), pointId: point.id, value: "50", correctiveAction: "4111111111111111" }),
      ),
    ).toBe("CARD_DATA_REFUSED");
    expect(await codeOf(recordTemperatureReading(database(), cook, { idempotencyKey: key(), pointId: point.id, value: "abc" }))).toBe(
      "INVALID_TEMPERATURE",
    );

    await updateTemperaturePoint(database(), manager, point.id, {
      name: point.name,
      kind: point.kind,
      minimumValue: "33",
      maximumValue: "41",
      checkIntervalMinutes: 240,
      sortOrder: 10,
      active: false,
      expectedVersion: point.version,
    });

    expect(await codeOf(recordTemperatureReading(database(), cook, { idempotencyKey: key(), pointId: point.id, value: "38" }))).toBe(
      "TEMPERATURE_POINT_INACTIVE",
    );
    expect(await listTemperaturePoints(database(), cook)).toEqual([]);
    expect(await listTemperaturePoints(database(), manager)).toHaveLength(1);
  });

  it("works out due and overdue checks on read", async () => {
    const point = await walkIn({ checkIntervalMinutes: 60 });

    await walkIn({ name: "No schedule", checkIntervalMinutes: null });

    const now = new Date();
    const recorded = await recordTemperatureReading(database(), cook, { idempotencyKey: key(), pointId: point.id, value: "38" });
    const soon = await listChecksDue(database(), cook, now);
    const later = await listChecksDue(database(), cook, new Date(now.getTime() + 2 * 3_600_000));
    const statusOf = (checks: typeof soon.checks, name: string) => checks.find((check) => check.point.name === name)!.status.state;

    expect(statusOf(soon.checks, "Walk-in cooler")).toBe("OK");
    expect(statusOf(later.checks, "Walk-in cooler")).toBe("OVERDUE");
    expect(statusOf(soon.checks, "No schedule")).toBe("NO_SCHEDULE");
    expect(soon.checks.find((check) => check.point.id === point.id)!.lastReading?.value).toBe("38.0");
    expect(recorded.inRange).toBe(true);
  });

  it("exports the log as CSV only with reports.export", async () => {
    const point = await walkIn();

    await recordTemperatureReading(database(), cook, { idempotencyKey: key(), pointId: point.id, value: "45", correctiveAction: "=cmd, moved stock" });

    const { csv, fileName } = await exportTemperatureLogCsv(database(), manager, { from: today, to: today });
    const lines = csv.trim().split("\r\n");

    expect(fileName).toBe(`temperature-log-${today}-to-${today}.csv`);
    expect(lines[0]).toContain("Corrective action");
    expect(lines[1]).toContain("Walk-in cooler,45.0,F,33.0–41.0 °F,No,\"'=cmd, moved stock\"");
    expect(await codeOf(exportTemperatureLogCsv(database(), cook, { from: today, to: today }))).toBe("PERMISSION_DENIED");
  });
});
