import { and, asc, desc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";

import type { Database } from "@/db";
import { assertVersionMatched, nextVersion } from "@/db/helpers/versioning";
import { locations, locationSettings, temperaturePoints, temperatureReadings } from "@/db/schema";
import type { TemperaturePointKind, TemperatureUnit } from "@/db/schema/food-safety";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { findUserIdsHolding } from "@/modules/auth/services/permission-holders";
import type { Actor } from "@/modules/auth/types";
import { findDisplayNamesByUser } from "@/modules/employees/queries/employee-display-names";
import { findLinkedEmployeeId } from "@/modules/employees/queries/scheduling-facts";
import { createNotifications } from "@/modules/notifications/notification-writer";
import { csvLine } from "@/modules/reporting/rules/csv";
import { AuthorizationError, BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";
import { businessDateOf, businessDateStart } from "@/shared/time/business-date-service";

import { assertNoCardNumber, assertSearchRange } from "../rules/manager-log-rules";
import {
  assertRange,
  checkStatus,
  correctiveActionFor,
  describeRange,
  isInRange,
  MAX_TEMPERATURE_LOG_DAYS,
  readingValue,
  type CheckStatus,
} from "../rules/temperature-rules";
import { actorHolds, assertPermission } from "./access";

// Phase 36 part 2 (policy 6): food-safety temperature logs. Check points are configuration;
// readings are append-only, each with its point's range copied onto it. An out-of-range reading
// needs a corrective action and notifies `food-safety.manage` holders in the same transaction.
// Overdue checks are worked out on read and never notified.

export const TEMPERATURE_READING_SCOPE = "restaurant.temperature-reading";

type PointRow = typeof temperaturePoints.$inferSelect;
type ReadingRow = typeof temperatureReadings.$inferSelect;

export type TemperaturePointView = {
  id: string;
  name: string;
  kind: TemperaturePointKind;
  unit: TemperatureUnit;
  minimumValue: string | null;
  maximumValue: string | null;
  rangeText: string;
  checkIntervalMinutes: number | null;
  sortOrder: number;
  active: boolean;
  version: number;
};

export type TemperatureReadingView = {
  id: string;
  pointId: string;
  pointName: string;
  value: string;
  unit: TemperatureUnit;
  rangeText: string;
  inRange: boolean;
  correctiveAction: string | null;
  takenAt: string;
  businessDate: string;
  recordedByName: string | null;
  followsUpReadingId: string | null;
  correctsReadingId: string | null;
  /** The reading that corrects this one, if any. */
  correctedByReadingId: string | null;
};

const pointView = (row: PointRow): TemperaturePointView => ({
  id: row.id,
  name: row.name,
  kind: row.kind as TemperaturePointKind,
  unit: row.unit as TemperatureUnit,
  minimumValue: row.minimumValue,
  maximumValue: row.maximumValue,
  rangeText: describeRange(row.minimumValue, row.maximumValue, row.unit),
  checkIntervalMinutes: row.checkIntervalMinutes,
  sortOrder: row.sortOrder,
  active: row.active,
  version: row.version,
});

async function locationClock(executor: DatabaseExecutor, locationId: string, now: Date) {
  const [row] = await executor
    .select({ timeZone: locations.timezone, businessDayCutoff: locationSettings.businessDayCutoff, unit: locationSettings.temperatureUnit })
    .from(locations)
    .innerJoin(locationSettings, eq(locationSettings.locationId, locations.id))
    .where(eq(locations.id, locationId));

  if (!row) {
    throw new NotFoundError("location");
  }

  const businessDate = businessDateOf(now, row);

  return { businessDate, dayStart: businessDateStart(businessDate, row), unit: row.unit as TemperatureUnit };
}

// ------------------------------------------------------------------------------ Points

/** Every check point here; inactive ones only for managers. */
export async function listTemperaturePoints(executor: DatabaseExecutor, actor: Actor): Promise<TemperaturePointView[]> {
  assertPermission(actor, "food-safety.view");

  const manage = actorHolds(actor, "food-safety.manage");
  const rows = await executor
    .select()
    .from(temperaturePoints)
    .where(and(eq(temperaturePoints.locationId, actor.locationId), ...(manage ? [] : [eq(temperaturePoints.active, true)])))
    .orderBy(asc(temperaturePoints.sortOrder), asc(temperaturePoints.name));

  return rows.map(pointView);
}

export type PointInput = {
  name: string;
  kind: TemperaturePointKind;
  minimumValue: string | null;
  maximumValue: string | null;
  checkIntervalMinutes: number | null;
  sortOrder: number;
};

function cleanRange(input: Pick<PointInput, "minimumValue" | "maximumValue">) {
  const minimum = input.minimumValue === null || input.minimumValue.trim() === "" ? null : readingValue(input.minimumValue);
  const maximum = input.maximumValue === null || input.maximumValue.trim() === "" ? null : readingValue(input.maximumValue);

  assertRange(minimum, maximum);

  return { minimumValue: minimum, maximumValue: maximum };
}

/** Policy 6: the unit is the given one or the location's default, and never changes. */
export async function createTemperaturePoint(
  database: Database,
  actor: Actor,
  input: PointInput & { unit?: TemperatureUnit | null },
): Promise<TemperaturePointView> {
  assertPermission(actor, "food-safety.manage");

  const range = cleanRange(input);

  return withTransaction(database, async (transaction) => {
    const unit = input.unit ?? (await locationClock(transaction, actor.locationId, new Date())).unit;
    const [row] = await transaction
      .insert(temperaturePoints)
      .values({
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        name: input.name.trim(),
        kind: input.kind,
        unit,
        ...range,
        checkIntervalMinutes: input.checkIntervalMinutes,
        sortOrder: input.sortOrder,
        createdByUserId: actor.userId,
        updatedByUserId: actor.userId,
      })
      .returning();

    return pointView(row!);
  });
}

/** Edits never change a reading, which keeps the range it was taken against. */
export async function updateTemperaturePoint(
  database: Database,
  actor: Actor,
  pointId: string,
  input: PointInput & { active: boolean; expectedVersion: number },
): Promise<TemperaturePointView> {
  assertPermission(actor, "food-safety.manage");

  const range = cleanRange(input);

  return withTransaction(database, async (transaction) => {
    const row = assertVersionMatched(
      await transaction
        .update(temperaturePoints)
        .set({
          name: input.name.trim(),
          kind: input.kind,
          ...range,
          checkIntervalMinutes: input.checkIntervalMinutes,
          sortOrder: input.sortOrder,
          active: input.active,
          updatedByUserId: actor.userId,
          version: nextVersion(temperaturePoints.version),
        })
        .where(
          and(
            eq(temperaturePoints.id, pointId),
            eq(temperaturePoints.locationId, actor.locationId),
            eq(temperaturePoints.version, input.expectedVersion),
          ),
        )
        .returning(),
      { type: "temperature check point", id: pointId },
    );

    return pointView(row);
  });
}

// ------------------------------------------------------------------------------ Readings

export type RecordReadingInput = {
  idempotencyKey: string;
  pointId: string;
  value: string;
  correctiveAction?: string | null;
  followsUpReadingId?: string | null;
  correctsReadingId?: string | null;
};

/** What a retry gets back. The corrective action isn't kept in the idempotency record. */
export type RecordedReading = { id: string; inRange: boolean; businessDate: string };

async function assertLinkedReading(executor: DatabaseExecutor, actor: Actor, readingId: string | null | undefined) {
  if (!readingId) {
    return;
  }

  const [row] = await executor
    .select({ id: temperatureReadings.id })
    .from(temperatureReadings)
    .where(and(eq(temperatureReadings.id, readingId), eq(temperatureReadings.locationId, actor.locationId)));

  if (!row) {
    throw new NotFoundError("temperature reading");
  }
}

/**
 * Policy 6: records one reading against its point's current range. A retry with the same key
 * records nothing more. Out of range, it needs a corrective action and notifies the location's
 * `food-safety.manage` holders once, in the same transaction.
 */
export async function recordTemperatureReading(
  database: Database,
  actor: Actor,
  input: RecordReadingInput,
): Promise<RecordedReading & { replayed: boolean }> {
  assertPermission(actor, "food-safety.record");

  const value = readingValue(input.value);
  const action = input.correctiveAction?.trim() ? input.correctiveAction.trim() : null;

  assertNoCardNumber(action);

  const { idempotencyKey, ...request } = input;
  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent<RecordedReading>(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: TEMPERATURE_READING_SCOPE,
        key: idempotencyKey,
        actorUserId: actor.userId,
        request: { ...request, value, correctiveAction: action, locationId: actor.locationId },
      },
      async () => {
        const [point] = await transaction
          .select()
          .from(temperaturePoints)
          .where(and(eq(temperaturePoints.id, input.pointId), eq(temperaturePoints.locationId, actor.locationId)));

        if (!point) {
          throw new NotFoundError("temperature check point");
        }

        if (!point.active) {
          throw new BusinessRuleError("TEMPERATURE_POINT_INACTIVE", "This check point is no longer in use.");
        }

        await assertLinkedReading(transaction, actor, input.followsUpReadingId);
        await assertLinkedReading(transaction, actor, input.correctsReadingId);

        const inRange = isInRange(value, point.minimumValue, point.maximumValue);
        const correctiveAction = correctiveActionFor(inRange, action);
        const now = new Date();
        const clock = await locationClock(transaction, actor.locationId, now);
        const [row] = await transaction
          .insert(temperatureReadings)
          .values({
            organizationId: actor.organizationId,
            locationId: actor.locationId,
            pointId: point.id,
            pointNameSnapshot: point.name,
            value,
            unit: point.unit,
            minimumValue: point.minimumValue,
            maximumValue: point.maximumValue,
            inRange,
            correctiveAction,
            takenAt: now,
            businessDate: clock.businessDate,
            recordedByUserId: actor.userId,
            recordedByEmployeeId: await findLinkedEmployeeId(transaction, { userId: actor.userId, organizationId: actor.organizationId }),
            followsUpReadingId: input.followsUpReadingId ?? null,
            correctsReadingId: input.correctsReadingId ?? null,
            createdAt: now,
          })
          .returning({ id: temperatureReadings.id });

        if (!inRange) {
          const recipients = await findUserIdsHolding(transaction, {
            organizationId: actor.organizationId,
            locationId: actor.locationId,
            permission: "food-safety.manage",
          });

          await createNotifications(
            transaction,
            { organizationId: actor.organizationId, locationId: actor.locationId, at: now },
            recipients.map((recipientUserId) => ({
              type: "TEMPERATURE_OUT_OF_RANGE" as const,
              recipientUserId,
              title: `${point.name} is out of range`,
              body: `${value} °${point.unit} (safe range ${describeRange(point.minimumValue, point.maximumValue, point.unit)}).`,
              links: { temperatureReadingId: row!.id },
              dedupeKey: `temp:${row!.id}`,
            })),
          );
        }

        return { id: row!.id, inRange, businessDate: clock.businessDate };
      },
    ),
  );

  return { ...outcome.response, replayed: outcome.replayed };
}

export type ReadingFilter = { from: string; to: string; pointId?: string | null; outOfRangeOnly?: boolean };

async function readingsBetween(executor: DatabaseExecutor, actor: Actor, filter: ReadingFilter): Promise<ReadingRow[]> {
  assertSearchRange(filter.from, filter.to, MAX_TEMPERATURE_LOG_DAYS);

  return executor
    .select()
    .from(temperatureReadings)
    .where(
      and(
        eq(temperatureReadings.locationId, actor.locationId),
        gte(temperatureReadings.businessDate, filter.from),
        lte(temperatureReadings.businessDate, filter.to),
        ...(filter.pointId ? [eq(temperatureReadings.pointId, filter.pointId)] : []),
        ...(filter.outOfRangeOnly ? [eq(temperatureReadings.inRange, false)] : []),
      ),
    )
    .orderBy(desc(temperatureReadings.takenAt))
    .limit(2000);
}

async function readingViews(executor: DatabaseExecutor, actor: Actor, rows: readonly ReadingRow[]): Promise<TemperatureReadingView[]> {
  const ids = rows.map((row) => row.id);
  const [names, corrections] = await Promise.all([
    findDisplayNamesByUser(executor, { organizationId: actor.organizationId, userIds: rows.map((row) => row.recordedByUserId) }),
    ids.length === 0
      ? Promise.resolve([])
      : executor
          .select({ id: temperatureReadings.id, correctsReadingId: temperatureReadings.correctsReadingId })
          .from(temperatureReadings)
          .where(and(isNotNull(temperatureReadings.correctsReadingId), inArray(temperatureReadings.correctsReadingId, ids))),
  ]);
  const correctedBy = new Map(corrections.map((row) => [row.correctsReadingId!, row.id]));

  return rows.map((row) => ({
    id: row.id,
    pointId: row.pointId,
    pointName: row.pointNameSnapshot,
    value: row.value,
    unit: row.unit as TemperatureUnit,
    rangeText: describeRange(row.minimumValue, row.maximumValue, row.unit),
    inRange: row.inRange,
    correctiveAction: row.correctiveAction,
    takenAt: row.takenAt.toISOString(),
    businessDate: row.businessDate,
    recordedByName: names.get(row.recordedByUserId) ?? null,
    followsUpReadingId: row.followsUpReadingId,
    correctsReadingId: row.correctsReadingId,
    correctedByReadingId: correctedBy.get(row.id) ?? null,
  }));
}

/** Policy 6: the log for one date or up to 31 days, newest first. */
export async function listTemperatureReadings(
  executor: DatabaseExecutor,
  actor: Actor,
  filter: ReadingFilter,
): Promise<TemperatureReadingView[]> {
  assertPermission(actor, "food-safety.view");

  return readingViews(executor, actor, await readingsBetween(executor, actor, filter));
}

export type CheckDue = { point: TemperaturePointView; lastReading: { value: string; inRange: boolean; takenAt: string } | null; status: CheckStatus };

/** Policy 6: each active point's last reading and whether a check is due, worked out now. */
export async function listChecksDue(executor: DatabaseExecutor, actor: Actor, now = new Date()): Promise<{ businessDate: string; checks: CheckDue[] }> {
  assertPermission(actor, "food-safety.view");

  const clock = await locationClock(executor, actor.locationId, now);
  const points = await executor
    .select()
    .from(temperaturePoints)
    .where(and(eq(temperaturePoints.locationId, actor.locationId), eq(temperaturePoints.active, true)))
    .orderBy(asc(temperaturePoints.sortOrder), asc(temperaturePoints.name));
  const lastRows =
    points.length === 0
      ? []
      : await executor
          .selectDistinctOn([temperatureReadings.pointId], {
            pointId: temperatureReadings.pointId,
            value: temperatureReadings.value,
            inRange: temperatureReadings.inRange,
            takenAt: temperatureReadings.takenAt,
          })
          .from(temperatureReadings)
          .where(inArray(temperatureReadings.pointId, points.map((point) => point.id)))
          .orderBy(temperatureReadings.pointId, desc(temperatureReadings.takenAt));
  const lastByPoint = new Map(lastRows.map((row) => [row.pointId, row]));

  return {
    businessDate: clock.businessDate,
    checks: points.map((point) => {
      const last = lastByPoint.get(point.id) ?? null;

      return {
        point: pointView(point),
        lastReading: last ? { value: last.value, inRange: last.inRange, takenAt: last.takenAt.toISOString() } : null,
        status: checkStatus(point.checkIntervalMinutes, last?.takenAt ?? null, clock.dayStart, now),
      };
    }),
  };
}

/** Policy 6: the log as CSV for an inspector. Needs `food-safety.view` and `reports.export`. */
export async function exportTemperatureLogCsv(
  executor: DatabaseExecutor,
  actor: Actor,
  filter: ReadingFilter,
): Promise<{ fileName: string; csv: string }> {
  assertPermission(actor, "food-safety.view");

  if (!actorHolds(actor, "reports.export")) {
    throw new AuthorizationError();
  }

  const views = await readingViews(executor, actor, await readingsBetween(executor, actor, filter));
  const lines = [
    csvLine([
      "Business date",
      "Taken at (UTC)",
      "Check point",
      "Temperature",
      "Unit",
      "Safe range",
      "In range",
      "Corrective action",
      "Recorded by",
      "Reading",
      "Corrects reading",
      "Corrected by reading",
      "Rechecks reading",
    ]),
    ...[...views].reverse().map((view) =>
      csvLine([
        view.businessDate,
        view.takenAt,
        view.pointName,
        view.value,
        view.unit,
        view.rangeText,
        view.inRange ? "Yes" : "No",
        view.correctiveAction,
        view.recordedByName ?? "No employee record",
        view.id,
        view.correctsReadingId,
        view.correctedByReadingId,
        view.followsUpReadingId,
      ]),
    ),
  ];

  return { fileName: `temperature-log-${filter.from}-to-${filter.to}.csv`, csv: `${lines.join("\r\n")}\r\n` };
}
