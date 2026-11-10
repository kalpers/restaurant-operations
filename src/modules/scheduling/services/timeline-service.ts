import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { findSchedulingFacts } from "@/modules/employees/queries/scheduling-facts";
import { localDateOf } from "@/shared/time/zoned-time";

import { findOpenTimeOffSpans } from "../repositories/employee-input-repository";
import {
  findActiveAssignmentsForShifts,
  findLatestUnfilledDetails,
  findOpenSwapAssignmentIds,
  findPeriodsCoveringDate,
  findShiftsOnDate,
  sumActiveMinutesByEmployee,
  type TimelineShiftRow,
} from "../repositories/timeline-repository";
import type { HardConstraintCode } from "../rules/eligibility";
import type {
  AssignmentRationale,
  UnfilledShiftDetail,
} from "../rules/explanation-builder";
import {
  assignLanes,
  axisWindow,
  hourlyHeadcount,
  hourTicks,
  minutesBetween,
  openSlots,
  positionColorIndex,
  sortEmployees,
  sortPositions,
} from "../rules/timeline-layout";
import { assertPermission, canReviewSchedules } from "./access";
import { findPeriodViolations } from "./schedule-service";
import { loadLocationContext } from "./scheduling-input";

// The read-only day timeline. Visibility follows the period page: everyone with
// `schedule.view` sees published and archived periods; reviewers also see drafts, and
// only they get the `reviewer` and `timeOff` fields. No wage, employment status, contact
// detail or time-off reason is ever selected or returned.

const PUBLIC_STATUSES = ["PUBLISHED", "ARCHIVED"] as const;
const REVIEW_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;

export type TimelineReviewerDetail = {
  assignmentSource: string | null;
  assignedAt: string | null;
  rationale: AssignmentRationale | null;
  stationNote: string | null;
  notes: string | null;
  violations: HardConstraintCode[];
  openSwap: boolean;
  employeePeriodMinutes: number | null;
  openSlotSummary: string | null;
};

export type TimelineBar = {
  kind: "ASSIGNMENT" | "OPEN";
  /** The assignment ID, or `open:<shiftId>:<n>` for an unfilled slot. */
  key: string;
  shiftId: string;
  positionId: string;
  employeeId: string | null;
  restaurantAreaName: string | null;
  shiftDate: string;
  startAt: string;
  endAt: string;
  endsNextDay: boolean;
  durationMinutes: number;
  periodId: string;
  periodName: string;
  periodStatus: string;
  requiredCount: number;
  filledCount: number;
  /** Lane within the row, for each grouping. */
  lanes: { employee: number; position: number };
  reviewer?: TimelineReviewerDetail;
};

export type TimelineEmployee = {
  id: string;
  displayName: string;
  employeeNumber: string;
  scheduledMinutes: number;
};

export type TimelinePosition = {
  id: string;
  name: string;
  code: string;
  colorIndex: number;
};

export type TimelineTimeOff = {
  employeeId: string;
  startAt: string;
  endAt: string;
  status: "APPROVED" | "PENDING";
};

export type DayTimeline = {
  date: string;
  today: string;
  timeZone: string;
  generatedAt: string;
  isReviewer: boolean;
  includeDrafts: boolean;
  window: { startAt: string; endAt: string };
  ticks: { startAt: string; label: string }[];
  positions: TimelinePosition[];
  employees: TimelineEmployee[];
  bars: TimelineBar[];
  headcount: { hourStartAt: string; byPosition: Record<string, number> }[];
  timeOff?: TimelineTimeOff[];
};

function iso(value: Date | number): string {
  return new Date(value).toISOString();
}

export async function getDayTimeline(
  executor: DatabaseExecutor,
  actor: Actor,
  input: { date?: string; includeDrafts: boolean },
): Promise<DayTimeline> {
  assertPermission(actor, "schedule.view");

  const isReviewer = canReviewSchedules(actor);
  const includeDrafts = isReviewer && input.includeDrafts;
  const { timeZone } = await loadLocationContext(executor, actor);
  const now = new Date();
  const today = localDateOf(now, timeZone);
  const date = input.date ?? today;
  const periods = await findPeriodsCoveringDate(executor, {
    locationId: actor.locationId,
    date,
    statuses: includeDrafts ? REVIEW_STATUSES : PUBLIC_STATUSES,
  });
  const periodsById = new Map(periods.map((period) => [period.id, period]));
  const shifts: TimelineShiftRow[] =
    periods.length === 0
      ? []
      : await findShiftsOnDate(executor, {
          periodIds: periods.map((period) => period.id),
          date,
        });
  const assignments =
    shifts.length === 0
      ? []
      : await findActiveAssignmentsForShifts(
          executor,
          shifts.map((shift) => shift.id),
        );
  const employeeIds = [...new Set(assignments.map((row) => row.employeeId))];
  const facts = await findSchedulingFacts(executor, {
    organizationId: actor.organizationId,
    employeeIds,
  });
  const window = axisWindow(
    date,
    timeZone,
    shifts.map((shift) => ({
      startMs: Number(shift.startAt),
      endMs: Number(shift.endAt),
    })),
  );
  const ticks = hourTicks(window, timeZone);
  const shiftsById = new Map(shifts.map((shift) => [shift.id, shift]));
  const filled = new Map<string, number>();

  for (const assignment of assignments) {
    filled.set(assignment.shiftId, (filled.get(assignment.shiftId) ?? 0) + 1);
  }

  const reviewerData = isReviewer
    ? await loadReviewerData(executor, actor, {
        periods: periods.filter((period) =>
          shifts.some((shift) => shift.schedulePeriodId === period.id),
        ),
        assignmentIds: assignments.map((row) => row.id),
        employeeIds,
        window,
      })
    : null;

  const sortedPositions = sortPositions(
    [
      ...new Map(
        shifts.map((shift) => [
          shift.positionId,
          { id: shift.positionId, name: shift.positionName, code: shift.positionCode },
        ]),
      ).values(),
    ],
  );
  const positions: TimelinePosition[] = sortedPositions.map((position, index) => ({
    ...position,
    colorIndex: positionColorIndex(index),
  }));

  type Draft = Omit<TimelineBar, "lanes">;
  const drafts: Draft[] = [];

  function baseBar(shift: TimelineShiftRow) {
    const period = periodsById.get(shift.schedulePeriodId)!;

    return {
      shiftId: shift.id,
      positionId: shift.positionId,
      restaurantAreaName: shift.restaurantAreaName,
      shiftDate: shift.shiftDate,
      startAt: iso(shift.startAt),
      endAt: iso(shift.endAt),
      endsNextDay: localDateOf(Number(shift.endAt) - 1, timeZone) !== shift.shiftDate,
      durationMinutes: minutesBetween(Number(shift.startAt), Number(shift.endAt)),
      periodId: period.id,
      periodName: period.name,
      periodStatus: period.status,
      requiredCount: shift.requiredEmployeeCount,
      filledCount: filled.get(shift.id) ?? 0,
    };
  }

  for (const assignment of assignments) {
    const shift = shiftsById.get(assignment.shiftId);

    if (!shift) {
      continue;
    }

    drafts.push({
      kind: "ASSIGNMENT",
      key: assignment.id,
      employeeId: assignment.employeeId,
      ...baseBar(shift),
      ...(reviewerData && {
        reviewer: {
          assignmentSource: assignment.assignmentSource,
          assignedAt: iso(assignment.assignedAt),
          rationale: (assignment.generationRationale ?? null) as AssignmentRationale | null,
          stationNote: shift.courseOrStationNote,
          notes: shift.notes,
          violations: reviewerData.violations.get(assignment.id) ?? [],
          openSwap: reviewerData.openSwaps.has(assignment.id),
          employeePeriodMinutes:
            reviewerData.periodMinutes.get(
              `${shift.schedulePeriodId}:${assignment.employeeId}`,
            ) ?? null,
          openSlotSummary: null,
        },
      }),
    });
  }

  for (const shift of shifts) {
    const open = openSlots(shift.requiredEmployeeCount, filled.get(shift.id) ?? 0);

    for (let slot = 1; slot <= open; slot += 1) {
      drafts.push({
        kind: "OPEN",
        key: `open:${shift.id}:${slot}`,
        employeeId: null,
        ...baseBar(shift),
        ...(reviewerData && {
          reviewer: {
            assignmentSource: null,
            assignedAt: null,
            rationale: null,
            stationNote: shift.courseOrStationNote,
            notes: shift.notes,
            violations: [],
            openSwap: false,
            employeePeriodMinutes: null,
            openSlotSummary: reviewerData.unfilled.get(shift.id) ?? null,
          },
        }),
      });
    }
  }

  const laneItems = (rowKeyOf: (bar: Draft) => string) =>
    assignLanes(
      drafts.map((bar) => ({
        key: bar.key,
        rowKey: rowKeyOf(bar),
        startMs: Date.parse(bar.startAt),
        endMs: Date.parse(bar.endAt),
      })),
    );
  const openRow = (bar: Draft) => `open:${bar.positionId}`;
  const employeeLanes = laneItems((bar) =>
    bar.employeeId ? bar.employeeId : openRow(bar),
  );
  const positionLanes = laneItems((bar) =>
    bar.employeeId ? `${bar.positionId}:${bar.employeeId}` : openRow(bar),
  );
  const bars: TimelineBar[] = drafts.map((bar) => ({
    ...bar,
    lanes: {
      employee: employeeLanes.get(bar.key) ?? 0,
      position: positionLanes.get(bar.key) ?? 0,
    },
  }));

  const dayMinutes = new Map<string, number>();

  for (const bar of bars) {
    if (bar.employeeId) {
      dayMinutes.set(
        bar.employeeId,
        (dayMinutes.get(bar.employeeId) ?? 0) + bar.durationMinutes,
      );
    }
  }

  const employees: TimelineEmployee[] = sortEmployees(
    facts.map((row) => ({
      id: row.id,
      displayName: row.displayName,
      employeeNumber: row.employeeNumber,
    })),
  ).map((row) => ({ ...row, scheduledMinutes: dayMinutes.get(row.id) ?? 0 }));

  const headcount = hourlyHeadcount(
    ticks,
    window,
    bars
      .filter((bar) => bar.kind === "ASSIGNMENT")
      .map((bar) => ({
        positionId: bar.positionId,
        startMs: Date.parse(bar.startAt),
        endMs: Date.parse(bar.endAt),
      })),
  ).map((row) => ({ hourStartAt: iso(row.hourStartMs), byPosition: row.byPosition }));

  return {
    date,
    today,
    timeZone,
    generatedAt: iso(now),
    isReviewer,
    includeDrafts,
    window: { startAt: iso(window.startMs), endAt: iso(window.endMs) },
    ticks: ticks.map((tick) => ({ startAt: iso(tick.startMs), label: tick.label })),
    positions,
    employees,
    bars,
    headcount,
    ...(reviewerData && { timeOff: reviewerData.timeOff }),
  };
}

/** Reviewer-only facts. Each is one query, or one set of queries per period. */
async function loadReviewerData(
  executor: DatabaseExecutor,
  actor: Actor,
  input: {
    periods: Awaited<ReturnType<typeof findPeriodsCoveringDate>>;
    assignmentIds: string[];
    employeeIds: string[];
    window: { startMs: number; endMs: number };
  },
) {
  const periodIds = input.periods.map((period) => period.id);
  const daysAssignments = new Set(input.assignmentIds);
  const violations = new Map<string, HardConstraintCode[]>();

  for (const period of input.periods) {
    for (const row of await findPeriodViolations(executor, actor, period)) {
      if (daysAssignments.has(row.assignmentId)) {
        violations.set(row.assignmentId, row.violations);
      }
    }
  }

  const [openSwaps, minutesRows, unfilledByPeriod, spans] = await Promise.all([
    input.assignmentIds.length === 0
      ? new Set<string>()
      : findOpenSwapAssignmentIds(executor, input.assignmentIds),
    input.employeeIds.length === 0
      ? []
      : sumActiveMinutesByEmployee(executor, {
          periodIds,
          employeeIds: input.employeeIds,
        }),
    periodIds.length === 0
      ? new Map<string, unknown>()
      : findLatestUnfilledDetails(executor, periodIds),
    input.employeeIds.length === 0
      ? []
      : findOpenTimeOffSpans(executor, input.employeeIds, {
          from: new Date(input.window.startMs),
          to: new Date(input.window.endMs),
        }),
  ]);

  const periodMinutes = new Map(
    minutesRows.map((row) => [
      `${row.periodId}:${row.employeeId}`,
      Math.round(Number(row.minutes)),
    ]),
  );
  const unfilled = new Map<string, string>();

  for (const details of unfilledByPeriod.values()) {
    for (const row of (details ?? []) as UnfilledShiftDetail[]) {
      unfilled.set(row.shiftId, row.summary);
    }
  }

  const timeOff: TimelineTimeOff[] = spans.map((span) => ({
    employeeId: span.employeeId,
    startAt: iso(span.startAt),
    endAt: iso(span.endAt),
    status: span.status === "APPROVED" ? "APPROVED" : "PENDING",
  }));

  return { violations, openSwaps, periodMinutes, unfilled, timeOff };
}
