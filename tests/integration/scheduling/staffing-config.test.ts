import { readFileSync } from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { schedulePeriods, shifts } from "@/db/schema";
import { findSchedulingFacts } from "@/modules/employees/queries/scheduling-facts";
import {
  addRequirement,
  applyTemplate,
  createTemplate,
  getRules,
  listTemplates,
  removeRequirement,
  saveRules,
  updateTemplate,
} from "@/modules/scheduling/services/config-service";
import {
  cancelShift,
  getPeriodDetail,
  updateShift,
} from "@/modules/scheduling/services/schedule-service";
import { AuthorizationError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import {
  createDraftPeriod,
  createSchedulableEmployee,
  createSchedulingScenario,
  MONDAY,
  type SchedulingScenario,
} from "../../fixtures/scheduling-fixtures";

const database = () => getDatabase();

async function periodVersion(periodId: string): Promise<number> {
  const [row] = await database()
    .select({ version: schedulePeriods.version })
    .from(schedulePeriods)
    .where(eq(schedulePeriods.id, periodId));

  return row!.version;
}

const baseRules = {
  avoidOvertime: true,
  weeklyOvertimeThreshold: "40.00",
  minimumRestHours: "8.00",
  minimumRestHard: false,
  maximumDaysPerWeek: null,
  maximumDaysHard: false,
  maximumConsecutiveDays: null,
  maximumConsecutiveHard: false,
  maximumWeeklyHours: null,
  balanceWeekendShifts: true,
  balanceClosingShifts: true,
  preferTargetHours: true,
  weekStartDay: 1,
  overtimeMultiplier: "1.50",
  lateClockInGraceMinutes: 5,
  dailyOvertimeThreshold: null,
};

describe("staffing templates and rules", () => {
  let scenario: SchedulingScenario;

  beforeEach(async () => {
    scenario = await createSchedulingScenario(database());
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  async function templateWithMondayServers(count = 2) {
    const template = await createTemplate(database(), scenario.owner, {
      name: "Standard week",
      description: null,
    });

    await addRequirement(database(), scenario.owner, template.id, {
      dayOfWeek: 1,
      positionId: scenario.server,
      restaurantAreaId: null,
      startTime: "17:00",
      endTime: "23:00",
      requiredEmployeeCount: count,
      priority: 5,
    });

    return template;
  }

  describe("templates", () => {
    it("creates demand, with no employees", async () => {
      await createSchedulableEmployee(database(), scenario);

      const template = await templateWithMondayServers();
      const period = await createDraftPeriod(database(), scenario.owner);
      const result = await applyTemplate(database(), scenario.owner, period.id, {
        templateId: template.id,
        expectedPeriodVersion: period.version,
      });
      const detail = await getPeriodDetail(database(), scenario.owner, period.id);

      expect(result.created).toBe(1);
      expect(detail.shifts).toHaveLength(1);
      expect(detail.shifts[0]).toMatchObject({
        shiftDate: MONDAY,
        requiredEmployeeCount: 2,
        priority: 5,
        assignments: [],
      });
    });

    it("can be applied repeatedly without creating duplicates", async () => {
      const template = await templateWithMondayServers();
      const period = await createDraftPeriod(database(), scenario.owner);
      const first = await applyTemplate(database(), scenario.owner, period.id, {
        templateId: template.id,
        expectedPeriodVersion: period.version,
      });
      const again = await applyTemplate(database(), scenario.owner, period.id, {
        templateId: template.id,
        expectedPeriodVersion: first.periodVersion,
      });

      expect(again.created).toBe(0);
      expect(again.periodVersion).toBe(first.periodVersion);
      expect(
        (await getPeriodDetail(database(), scenario.owner, period.id)).shifts,
      ).toHaveLength(1);
    });

    it("doesn't overwrite an edited shift or bring back a cancelled one", async () => {
      const template = await templateWithMondayServers();
      const period = await createDraftPeriod(database(), scenario.owner);
      const applied = await applyTemplate(database(), scenario.owner, period.id, {
        templateId: template.id,
        expectedPeriodVersion: period.version,
      });
      const [shift] = (
        await getPeriodDetail(database(), scenario.owner, period.id)
      ).shifts;

      await updateShift(database(), scenario.owner, shift!.id, {
        positionId: scenario.server,
        restaurantAreaId: null,
        shiftDate: MONDAY,
        startTime: "18:00",
        endTime: "23:00",
        requiredEmployeeCount: 1,
        courseOrStationNote: null,
        notes: "Edited",
        priority: 0,
        expectedVersion: shift!.version,
        expectedPeriodVersion: applied.periodVersion,
      });

      const reapplied = await applyTemplate(
        database(),
        scenario.owner,
        period.id,
        {
          templateId: template.id,
          expectedPeriodVersion: await periodVersion(period.id),
        },
      );
      const [edited] = await database()
        .select()
        .from(shifts)
        .where(eq(shifts.id, shift!.id));

      expect(reapplied.created).toBe(0);
      expect(edited).toMatchObject({ notes: "Edited", requiredEmployeeCount: 1 });

      await cancelShift(database(), scenario.owner, shift!.id, {
        expectedVersion: edited!.version,
        expectedPeriodVersion: await periodVersion(period.id),
      });
      await applyTemplate(database(), scenario.owner, period.id, {
        templateId: template.id,
        expectedPeriodVersion: await periodVersion(period.id),
      });

      expect(
        (await getPeriodDetail(database(), scenario.owner, period.id)).shifts,
      ).toEqual([]);
    });

    it("supports a requirement crossing midnight", async () => {
      const template = await createTemplate(database(), scenario.owner, {
        name: "Late",
        description: null,
      });

      await addRequirement(database(), scenario.owner, template.id, {
        dayOfWeek: 1,
        positionId: scenario.server,
        restaurantAreaId: null,
        startTime: "22:00",
        endTime: "02:00",
        requiredEmployeeCount: 1,
        priority: 0,
      });

      const period = await createDraftPeriod(database(), scenario.owner);

      await applyTemplate(database(), scenario.owner, period.id, {
        templateId: template.id,
        expectedPeriodVersion: period.version,
      });

      const [shift] = (
        await getPeriodDetail(database(), scenario.owner, period.id)
      ).shifts;

      expect(shift?.shiftDate).toBe(MONDAY);
      expect(Number(shift?.endAt) - Number(shift?.startAt)).toBe(4 * 3_600_000);
    });

    it("skips a requirement whose local time doesn't exist and reports it", async () => {
      const template = await createTemplate(database(), scenario.owner, {
        name: "Overnight",
        description: null,
      });

      // 2030-03-10 is a Sunday when the clocks skip 02:00 to 03:00.
      await addRequirement(database(), scenario.owner, template.id, {
        dayOfWeek: 0,
        positionId: scenario.server,
        restaurantAreaId: null,
        startTime: "02:30",
        endTime: "06:00",
        requiredEmployeeCount: 1,
        priority: 0,
      });

      const period = await createDraftPeriod(database(), scenario.owner, {
        startDate: "2030-03-10",
        endDate: "2030-03-10",
      });
      const result = await applyTemplate(database(), scenario.owner, period.id, {
        templateId: template.id,
        expectedPeriodVersion: period.version,
      });

      expect(result.created).toBe(0);
      expect(result.skipped).toEqual([
        expect.objectContaining({ date: "2030-03-10" }),
      ]);
    });

    it("ignores a removed requirement and refuses an inactive template", async () => {
      const template = await templateWithMondayServers();
      const [listed] = await listTemplates(database(), scenario.owner);
      const period = await createDraftPeriod(database(), scenario.owner);

      await removeRequirement(
        database(),
        scenario.owner,
        template.id,
        listed!.requirements[0]!.id,
      );

      await expect(
        applyTemplate(database(), scenario.owner, period.id, {
          templateId: template.id,
          expectedPeriodVersion: period.version,
        }),
      ).resolves.toMatchObject({ created: 0 });

      await updateTemplate(database(), scenario.owner, template.id, {
        name: "Standard week",
        description: null,
        active: false,
        expectedVersion: template.version,
      });

      await expect(
        applyTemplate(database(), scenario.owner, period.id, {
          templateId: template.id,
          expectedPeriodVersion: period.version,
        }),
      ).rejects.toMatchObject({ code: "TEMPLATE_INACTIVE" });
    });

    it("validates the position and area against the context", async () => {
      const template = await createTemplate(database(), scenario.owner, {
        name: "Checked",
        description: null,
      });
      const other = await createSchedulingScenario(database());

      await expect(
        addRequirement(database(), scenario.owner, template.id, {
          dayOfWeek: 1,
          positionId: other.server,
          restaurantAreaId: null,
          startTime: "17:00",
          endTime: "23:00",
          requiredEmployeeCount: 1,
          priority: 0,
        }),
      ).rejects.toThrow("active position");
    });

    it("rejects a duplicate name, and another location's template", async () => {
      const template = await templateWithMondayServers();

      await expect(
        createTemplate(database(), scenario.owner, {
          name: "Standard week",
          description: null,
        }),
      ).rejects.toMatchObject({ code: "TEMPLATE_NAME_EXISTS" });

      const period = await createDraftPeriod(database(), scenario.ownerAtB);

      await expect(
        applyTemplate(database(), scenario.ownerAtB, period.id, {
          templateId: template.id,
          expectedPeriodVersion: period.version,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("needs the template permission to manage, and edit to apply", async () => {
      const editor = await actorWith(database(), scenario, ["schedule.edit"]);
      const manager = await actorWith(database(), scenario, [
        "schedule.templates.manage",
      ]);
      const template = await templateWithMondayServers();
      const period = await createDraftPeriod(database(), scenario.owner);

      await expect(
        createTemplate(database(), editor, { name: "No", description: null }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        applyTemplate(database(), manager, period.id, {
          templateId: template.id,
          expectedPeriodVersion: period.version,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });
  });

  describe("rules", () => {
    it("falls back to defaults for a location with no row", async () => {
      await expect(getRules(database(), scenario.owner)).resolves.toMatchObject({
        weeklyOvertimeThreshold: "40.00",
        minimumRestHours: "8.00",
        version: null,
      });
    });

    it("saves structured rules with a version check", async () => {
      await saveRules(database(), scenario.owner, {
        ...baseRules,
        weeklyOvertimeThreshold: "35.50",
        expectedVersion: null,
      });

      const saved = await getRules(database(), scenario.owner);

      expect(saved).toMatchObject({
        weeklyOvertimeThreshold: "35.50",
        version: 1,
      });

      await saveRules(database(), scenario.owner, {
        ...baseRules,
        expectedVersion: 1,
      });

      await expect(
        saveRules(database(), scenario.owner, {
          ...baseRules,
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
    });

    it("rejects a hard limit with no value and hours with too many places", async () => {
      await expect(
        saveRules(database(), scenario.owner, {
          ...baseRules,
          maximumDaysHard: true,
          expectedVersion: null,
        }),
      ).rejects.toMatchObject({ code: "HARD_LIMIT_NEEDS_VALUE" });
      await expect(
        saveRules(database(), scenario.owner, {
          ...baseRules,
          weeklyOvertimeThreshold: "40.005",
          expectedVersion: null,
        }),
      ).rejects.toThrow("two decimal places");
    });

    it("needs the rules permission", async () => {
      const editor = await actorWith(database(), scenario, ["schedule.edit"]);

      await expect(getRules(database(), editor)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });
  });

  describe("the HR boundary", () => {
    it("exposes exactly the fields scheduling needs, and nothing restricted", async () => {
      const employeeId = await createSchedulableEmployee(database(), scenario);
      const [facts] = await findSchedulingFacts(database(), {
        organizationId: scenario.organizationId,
        employeeIds: [employeeId],
      });

      expect(Object.keys(facts!).sort()).toEqual([
        "displayName",
        "employeeNumber",
        "employmentStatus",
        "id",
        "locations",
        "positions",
      ]);
    });

    it("the scheduling module never imports a restricted HR source", () => {
      const roots = [
        "src/modules/scheduling/rules/eligibility.ts",
        "src/modules/scheduling/rules/candidate-scorer.ts",
        "src/modules/scheduling/generator/schedule-generator.ts",
        "src/modules/scheduling/services/scheduling-input.ts",
        "src/modules/employees/queries/scheduling-facts.ts",
      ];

      for (const file of roots) {
        const source = readFileSync(path.join(process.cwd(), file), "utf8");

        expect(source).not.toMatch(
          /employeePositionCompensation|employeeAddresses|employeeEmergencyContacts|employeeDisciplinaryActions|employeeDocuments|employeeNotes|employeePerformanceReviews|compensation-repository|personal-repository|hr-record-repository|userRoles|rolePermissions/,
        );
      }
    });
  });
});
