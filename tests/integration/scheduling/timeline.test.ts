import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getEnv } from "@/config/env";
import { closeDatabase, getDatabase } from "@/db";
import * as schema from "@/db/schema";
import {
  auditEvents,
  employees,
  scheduleGenerationRuns,
  schedulePeriods,
  shiftAssignments,
  shifts,
  shiftSwapRequests,
  timeOffRequests,
} from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import {
  archivePeriod,
  assignEmployee,
  cancelShift,
  publishPeriod,
  removeAssignment,
} from "@/modules/scheduling/services/schedule-service";
import {
  approveSwap,
  openSwapForEmployee,
  recordSwapAcceptance,
} from "@/modules/scheduling/services/swap-service";
import {
  approveTimeOff,
  requestTimeOffForEmployee,
} from "@/modules/scheduling/services/time-off-service";
import {
  getDayTimeline,
  type DayTimeline,
} from "@/modules/scheduling/services/timeline-service";
import { timelineQuerySchema } from "@/modules/scheduling/validators/scheduling-validators";
import { AuthorizationError } from "@/shared/errors/app-error";
import { terminateEmployee } from "@/workflows/terminate-employee/terminate-employee";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import {
  createDraftPeriod,
  createSchedulableEmployee,
  createSchedulingScenario,
  createShiftFixture,
  MONDAY,
  TUESDAY,
  type SchedulingScenario,
} from "../../fixtures/scheduling-fixtures";

const database = () => getDatabase();

/** Every key in a value, at any depth, split into lower-case camelCase words. */
function keyWords(value: unknown, words = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => keyWords(item, words));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      for (const word of key.split(/(?=[A-Z])/)) {
        words.add(word.toLowerCase());
      }

      keyWords(child, words);
    }
  }

  return words;
}

const FORBIDDEN_WORDS = [
  "wage",
  "rate",
  "hourly",
  "salary",
  "annual",
  "compensation",
  "cost",
  "employment",
  "phone",
  "email",
  "address",
  "reason",
  "birth",
];

describe("Phase 14: day timeline", () => {
  let scenario: SchedulingScenario;
  let staff: Actor;

  beforeEach(async () => {
    scenario = await createSchedulingScenario(database());
    staff = await actorWith(database(), scenario, ["schedule.view"]);
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  async function versionOf(periodId: string): Promise<number> {
    const [row] = await database()
      .select({ version: schedulePeriods.version })
      .from(schedulePeriods)
      .where(eq(schedulePeriods.id, periodId));

    return row!.version;
  }

  /** A period with one shift per entry, each assigned to the given employees. */
  async function schedule(
    entries: {
      employees?: string[];
      overrides?: Parameters<typeof createShiftFixture>[4];
    }[],
    options: { publish?: boolean; actor?: Actor; startDate?: string; endDate?: string } = {},
  ) {
    const actor = options.actor ?? scenario.owner;
    const period = await createDraftPeriod(database(), actor, {
      ...(options.startDate ? { startDate: options.startDate } : {}),
      ...(options.endDate ? { endDate: options.endDate } : {}),
    });
    const created: { shiftId: string; assignmentIds: string[] }[] = [];

    for (const entry of entries) {
      const shift = await createShiftFixture(
        database(),
        actor,
        { id: period.id, version: await versionOf(period.id) },
        scenario,
        entry.overrides ?? {},
      );
      const assignmentIds: string[] = [];

      for (const employeeId of entry.employees ?? []) {
        const { id } = await assignEmployee(database(), actor, shift.id, {
          employeeId,
          notes: null,
          expectedPeriodVersion: await versionOf(period.id),
        });

        assignmentIds.push(id);
      }

      created.push({ shiftId: shift.id, assignmentIds });
    }

    if (options.publish) {
      await publishPeriod(database(), actor, period.id, {
        expectedVersion: await versionOf(period.id),
      });
    }

    return { periodId: period.id, shifts: created };
  }

  const timeline = (actor: Actor, date = MONDAY, includeDrafts = true) =>
    getDayTimeline(database(), actor, { date, includeDrafts });

  const assigned = (data: DayTimeline) =>
    data.bars.filter((bar) => bar.kind === "ASSIGNMENT");

  describe("visibility", () => {
    it("hides a draft from staff: a draft-only day is empty, not forbidden", async () => {
      const employee = await createSchedulableEmployee(database(), scenario);

      await schedule([{ employees: [employee] }]);

      const data = await timeline(staff);

      expect(data.bars).toEqual([]);
      expect(data.employees).toEqual([]);
      expect(data.isReviewer).toBe(false);
    });

    it("shows a reviewer drafts by default, and hides them on request", async () => {
      const employee = await createSchedulableEmployee(database(), scenario);

      await schedule([{ employees: [employee] }]);

      const withDrafts = await timeline(scenario.owner);
      const without = await timeline(scenario.owner, MONDAY, false);

      expect(assigned(withDrafts)).toHaveLength(1);
      expect(assigned(withDrafts)[0]?.periodStatus).toBe("DRAFT");
      expect(without.bars).toEqual([]);
      expect(without.includeDrafts).toBe(false);
    });

    it("ignores includeDrafts for staff", async () => {
      const employee = await createSchedulableEmployee(database(), scenario);

      await schedule([{ employees: [employee] }]);

      expect((await timeline(staff, MONDAY, true)).bars).toEqual([]);
    });

    it("shows published and archived periods to staff", async () => {
      const employee = await createSchedulableEmployee(database(), scenario);
      const published = await schedule([{ employees: [employee] }], { publish: true });

      expect(assigned(await timeline(staff))).toHaveLength(1);

      await archivePeriod(database(), scenario.owner, published.periodId, {
        expectedVersion: await versionOf(published.periodId),
      });

      const archived = await timeline(staff);

      expect(assigned(archived)[0]?.periodStatus).toBe("ARCHIVED");
    });

    it("needs schedule.view, checked as a permission", async () => {
      const nobody = await actorWith(database(), scenario, ["employees.view"]);

      await expect(timeline(nobody)).rejects.toBeInstanceOf(AuthorizationError);
    });
  });

  describe("what appears", () => {
    it("never shows another location's shifts", async () => {
      const employee = await createSchedulableEmployee(database(), scenario);

      await schedule([{ employees: [employee] }], { publish: true });

      const atB = await createDraftPeriod(database(), scenario.ownerAtB);

      await createShiftFixture(database(), scenario.ownerAtB, atB, scenario);

      const data = await timeline(scenario.owner);

      expect(data.bars.every((bar) => bar.periodId !== atB.id)).toBe(true);
      expect((await timeline(scenario.ownerAtB)).bars.every((bar) => bar.periodId === atB.id)).toBe(true);
    });

    it("leaves out cancelled shifts and removed assignments", async () => {
      const employee = await createSchedulableEmployee(database(), scenario);
      const draft = await schedule([
        { employees: [employee] },
        { overrides: { startTime: "10:00", endTime: "14:00" } },
      ]);
      const [kept, cancelled] = draft.shifts;
      const [cancelledRow] = await database()
        .select({ version: shifts.version })
        .from(shifts)
        .where(eq(shifts.id, cancelled!.shiftId));

      await cancelShift(database(), scenario.owner, cancelled!.shiftId, {
        expectedVersion: cancelledRow!.version,
        expectedPeriodVersion: await versionOf(draft.periodId),
      });
      await removeAssignment(database(), scenario.owner, kept!.assignmentIds[0]!, {
        expectedPeriodVersion: await versionOf(draft.periodId),
      });

      const data = await timeline(scenario.owner);

      expect(data.bars.map((bar) => bar.shiftId)).toEqual([kept!.shiftId]);
      expect(data.bars[0]?.kind).toBe("OPEN");
      expect(data.employees).toEqual([]);
    });

    it("shows the new holder after a completed swap, with SHIFT_SWAP as the source", async () => {
      const holder = await createSchedulableEmployee(database(), scenario, { firstName: "Holder" });
      const target = await createSchedulableEmployee(database(), scenario, { firstName: "Target" });
      const published = await schedule([{ employees: [holder] }], { publish: true });
      const swap = await openSwapForEmployee(database(), scenario.owner, {
        assignmentId: published.shifts[0]!.assignmentIds[0]!,
        targetEmployeeId: target,
        reason: null,
      });

      await recordSwapAcceptance(database(), scenario.owner, swap.id, { expectedVersion: 1 });
      await approveSwap(database(), scenario.owner, swap.id, { expectedVersion: 2 });

      const bars = assigned(await timeline(scenario.owner));

      expect(bars).toHaveLength(1);
      expect(bars[0]?.employeeId).toBe(target);
      expect(bars[0]?.reviewer?.assignmentSource).toBe("SHIFT_SWAP");
    });

    it("draws open slots for unfilled places, never for an over-filled shift", async () => {
      const first = await createSchedulableEmployee(database(), scenario);

      await schedule([{ employees: [first], overrides: { requiredEmployeeCount: 3 } }]);

      const data = await timeline(scenario.owner);
      const open = data.bars.filter((bar) => bar.kind === "OPEN");

      expect(open.map((bar) => bar.key)).toEqual([
        `open:${open[0]!.shiftId}:1`,
        `open:${open[0]!.shiftId}:2`,
      ]);
      expect(open.every((bar) => bar.filledCount === 1 && bar.requiredCount === 3)).toBe(true);
    });

    it("shows an overnight shift on its start date only", async () => {
      const employee = await createSchedulableEmployee(database(), scenario);

      await schedule(
        [{ employees: [employee], overrides: { startTime: "20:00", endTime: "02:00" } }],
        { publish: true },
      );

      const monday = await timeline(staff, MONDAY);
      const tuesday = await timeline(staff, TUESDAY);
      const bar = assigned(monday)[0]!;

      expect(bar.endsNextDay).toBe(true);
      expect(bar.durationMinutes).toBe(360);
      expect(Date.parse(monday.window.endAt)).toBeGreaterThanOrEqual(Date.parse(bar.endAt));
      expect(tuesday.bars).toEqual([]);
    });

    it("does not call a shift ending exactly at midnight next-day", async () => {
      const employee = await createSchedulableEmployee(database(), scenario);

      await schedule([{ employees: [employee], overrides: { startTime: "18:00", endTime: "00:00" } }]);

      expect(assigned(await timeline(scenario.owner))[0]?.endsNextDay).toBe(false);
    });

    it("counts headcount per position and hour, and day minutes per employee", async () => {
      const server = await createSchedulableEmployee(database(), scenario, { firstName: "Ana" });
      const bartender = await createSchedulableEmployee(database(), scenario, {
        positionId: scenario.bartender,
        firstName: "Ben",
      });

      await schedule([
        { employees: [server], overrides: { startTime: "10:00", endTime: "12:00" } },
        { employees: [server], overrides: { startTime: "17:00", endTime: "18:30" } },
        {
          employees: [bartender],
          overrides: { positionId: scenario.bartender, startTime: "11:00", endTime: "13:00" },
        },
      ]);

      const data = await timeline(scenario.owner);
      const hourAt = (label: string) => {
        const index = data.ticks.findIndex((tick) => tick.label === label);

        return data.headcount[index]!.byPosition;
      };

      expect(hourAt("10:00")).toEqual({ [scenario.server]: 1 });
      expect(hourAt("11:00")).toEqual({ [scenario.server]: 1, [scenario.bartender]: 1 });
      expect(hourAt("12:00")).toEqual({ [scenario.bartender]: 1 });
      expect(data.employees.map((row) => [row.displayName.split(" ")[0], row.scheduledMinutes])).toEqual([
        ["Ana", 210],
        ["Ben", 120],
      ]);
      expect(data.positions.map((row) => row.colorIndex)).toEqual([0, 1]);
    });

    it("puts a draft overlapping a published shift in a second lane", async () => {
      const employee = await createSchedulableEmployee(database(), scenario);

      await schedule([{ employees: [employee] }], { publish: true });

      // A second draft for the same day can't hold the same person at the same time
      // (overlap is a hard constraint), so the overlapping bar is a draft open slot.
      const draft = await createDraftPeriod(database(), scenario.owner, { name: "Alternative" });

      await createShiftFixture(database(), scenario.owner, draft, scenario);

      const data = await timeline(scenario.owner);
      const draftBar = data.bars.find((bar) => bar.periodId === draft.id)!;

      expect(draftBar.periodStatus).toBe("DRAFT");
      expect(draftBar.kind).toBe("OPEN");
      expect(draftBar.lanes.position).toBe(0);
    });
  });

  describe("reviewer details and redaction", () => {
    it("gives reviewers source, notes, open swap, hours and time off", async () => {
      const employee = await createSchedulableEmployee(database(), scenario);
      const published = await schedule(
        [
          {
            employees: [employee],
            overrides: { notes: "Training night", courseOrStationNote: "Patio" },
          },
          { employees: [employee], overrides: { shiftDate: TUESDAY } },
        ],
        { publish: true },
      );
      const { id: timeOffId } = await requestTimeOffForEmployee(
        database(),
        scenario.owner,
        employee,
        {
          startDate: MONDAY,
          startTime: "08:00",
          endDate: MONDAY,
          endTime: "12:00",
          requestType: "VACATION",
          reason: "Dentist",
          employeeNote: null,
        },
      );

      await approveTimeOff(database(), scenario.owner, timeOffId, {
        managerNote: null,
        expectedVersion: 1,
      });
      await openSwapForEmployee(database(), scenario.owner, {
        assignmentId: published.shifts[0]!.assignmentIds[0]!,
        targetEmployeeId: null,
        reason: "Exam",
      });

      const data = await timeline(scenario.owner);
      const bar = assigned(data)[0]!;

      expect(bar.reviewer).toMatchObject({
        assignmentSource: "MANUAL",
        notes: "Training night",
        stationNote: "Patio",
        openSwap: true,
        employeePeriodMinutes: 600,
        violations: [],
      });
      expect(data.timeOff).toHaveLength(1);
      expect(Object.keys(data.timeOff![0]!).sort()).toEqual(["employeeId", "endAt", "startAt", "status"]);
      expect(data.timeOff![0]?.status).toBe("APPROVED");
      expect(JSON.stringify(data)).not.toContain("Dentist");
      expect(JSON.stringify(data)).not.toContain("Exam");
    });

    it("sends staff no reviewer fields and no time off", async () => {
      const employee = await createSchedulableEmployee(database(), scenario);

      await schedule([{ employees: [employee], overrides: { notes: "Manager only" } }], {
        publish: true,
      });

      const data = await timeline(staff);

      expect(data.bars.length).toBeGreaterThan(0);
      expect(data.bars.every((bar) => !("reviewer" in bar))).toBe(true);
      expect("timeOff" in data).toBe(false);
      expect(JSON.stringify(data)).not.toContain("Manager only");
    });

    it("never returns a wage, employment status, contact or reason field", async () => {
      const employee = await createSchedulableEmployee(database(), scenario);

      await schedule([{ employees: [employee], overrides: { requiredEmployeeCount: 2 } }], {
        publish: true,
      });

      for (const actor of [scenario.owner, staff]) {
        const words = keyWords(await timeline(actor));

        expect(FORBIDDEN_WORDS.filter((word) => words.has(word))).toEqual([]);
      }
    });

    it("reports a terminated employee's assignment to reviewers only", async () => {
      const employee = await createSchedulableEmployee(database(), scenario);

      await schedule([{ employees: [employee] }], { publish: true });

      const [row] = await database()
        .select({ version: employees.version })
        .from(employees)
        .where(eq(employees.id, employee));

      await terminateEmployee(database(), scenario.owner, {
        employeeId: employee,
        terminationDate: "2026-01-02",
        reason: null,
        expectedVersion: row!.version,
      });

      expect(assigned(await timeline(scenario.owner))[0]?.reviewer?.violations).toContain(
        "EMPLOYEE_NOT_SCHEDULABLE",
      );
      expect(assigned(await timeline(staff))[0]).not.toHaveProperty("reviewer");
    });
  });

  describe("read-only and cost", () => {
    const tables = [
      schedulePeriods,
      shifts,
      shiftAssignments,
      shiftSwapRequests,
      timeOffRequests,
      scheduleGenerationRuns,
      auditEvents,
    ] as const;

    async function rowCounts(): Promise<number[]> {
      return Promise.all(
        tables.map(async (table) => {
          const [row] = await database().select({ value: count() }).from(table);

          return row!.value;
        }),
      );
    }

    it("writes nothing, including no audit event", async () => {
      const employee = await createSchedulableEmployee(database(), scenario);

      await schedule([{ employees: [employee] }], { publish: true });

      const before = await rowCounts();

      await timeline(scenario.owner);
      await timeline(staff);

      expect(await rowCounts()).toEqual(before);
    });

    it("runs the same number of queries for 3 staff as for 30", async () => {
      let statements = 0;
      const client = postgres(getEnv().DATABASE_URL, {
        max: 1,
        debug: () => {
          statements += 1;
        },
      });
      const counted = drizzle(client, { schema });

      try {
        // The first query on a new connection also looks up types; leave it out.
        await getDayTimeline(counted, scenario.owner, { date: MONDAY, includeDrafts: true });

        const measure = async (staffCount: number, date: string) => {
          const ids: string[] = [];

          for (let index = 0; index < staffCount; index += 1) {
            ids.push(await createSchedulableEmployee(database(), scenario));
          }

          await schedule(
            ids.map((id) => ({ employees: [id], overrides: { shiftDate: date } })),
            { publish: true, startDate: date, endDate: date },
          );

          statements = 0;
          await getDayTimeline(counted, scenario.owner, { date, includeDrafts: true });

          return statements;
        };

        const few = await measure(3, "2030-02-04");
        const many = await measure(30, "2030-02-11");

        expect(few).toBeGreaterThan(0);
        expect(many).toBe(few);
      } finally {
        await client.end();
      }
    }, 120_000);
  });

  describe("query validation", () => {
    it("requires a real date and reads includeDrafts as text", () => {
      expect(timelineQuerySchema.safeParse({ date: "2030-02-30" }).success).toBe(false);
      expect(timelineQuerySchema.safeParse({}).success).toBe(false);
      expect(timelineQuerySchema.parse({ date: MONDAY })).toEqual({
        date: MONDAY,
        includeDrafts: true,
      });
      expect(timelineQuerySchema.parse({ date: MONDAY, includeDrafts: "false" }).includeDrafts).toBe(false);
      expect(timelineQuerySchema.safeParse({ date: MONDAY, includeDrafts: "yes" }).success).toBe(false);
    });
  });
});
