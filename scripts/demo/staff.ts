import { and, eq, inArray, like } from "drizzle-orm";

import type { Database } from "../../src/db";
import {
  AVAILABILITY_PATTERNS,
  PIZZA_EMPLOYEES,
  PIZZA_POSITIONS,
  PIZZA_RATIOS,
  PIZZA_TIME_OFF,
  PIZZA_TIP_POOL,
  PIZZA_WEEK,
  type AvailabilityWindow,
  type PizzaEmployee,
} from "../../src/db/demo/pizza/staff";
import {
  certificationTypes,
  employeeAvailability,
  employeeCertifications,
  employees,
  positions,
  staffingTemplates,
  timeOffRequests,
} from "../../src/db/schema";
import type { Actor } from "../../src/modules/auth/types";
import { assignPosition } from "../../src/modules/employees/services/assignment-service";
import { addCertification } from "../../src/modules/employees/services/certification-service";
import { changeCompensation } from "../../src/modules/employees/services/compensation-service";
import { createEmployee } from "../../src/modules/employees/services/employee-service";
import { updatePersonalContact } from "../../src/modules/employees/services/personal-service";
import { createPosition } from "../../src/modules/employees/services/reference-service";
import { addRecurringAvailability } from "../../src/modules/scheduling/services/availability-service";
import { addRequirement, createTemplate } from "../../src/modules/scheduling/services/config-service";
import { createRatio, getForecastSettings } from "../../src/modules/scheduling/services/forecast-service";
import { approveTimeOff, requestTimeOffForEmployee } from "../../src/modules/scheduling/services/time-off-service";
import { readTipRule, saveTipRule } from "../../src/modules/settlements/services/tip-service";
import { addDays, dayOfWeek } from "../../src/shared/time/zoned-time";

import { codeOf, need } from "./helpers";

export const PIZZA_TEMPLATE_NAME = "Pizza week";

export type StaffSummary = {
  positions: number;
  employees: number;
  availabilityWindows: number;
  certifications: number;
  templateCreated: boolean;
  ratios: number;
  tipPool: boolean;
};

async function positionIds(database: Database, organizationId: string): Promise<Map<string, string>> {
  return new Map(
    (await database.select({ id: positions.id, code: positions.code }).from(positions).where(eq(positions.organizationId, organizationId))).map((row) => [row.code, row.id]),
  );
}

const workEmail = (demo: PizzaEmployee) =>
  `${demo.firstName}.${demo.lastName}`
    .normalize("NFD")
    .replace(/[^\w.]/g, "")
    .toLowerCase()
    .concat("@demo.example.test");

/**
 * Positions, the roster with pay per position, availability, certifications, the "Pizza week"
 * template, staffing ratios and the tip pool, through the services a manager would use. Run with
 * the clock moved back to before the history (so the template and pay are in place for every past
 * week). Each part skips what exists, so reruns add nothing and hand edits survive.
 */
export async function seedPizzaStaff(database: Database, owner: Actor, today: string): Promise<StaffSummary> {
  const summary: StaffSummary = { positions: 0, employees: 0, availabilityWindows: 0, certifications: 0, templateCreated: false, ratios: 0, tipPool: false };
  const ids = await positionIds(database, owner.organizationId);

  for (const position of PIZZA_POSITIONS) {
    if (!ids.has(position.code)) {
      ids.set(position.code, (await createPosition(database, owner, position)).id);
      summary.positions += 1;
    }
  }

  // ------------------------------------------------------------------ roster
  const existing = new Set(
    (await database.select({ number: employees.employeeNumber }).from(employees).where(like(employees.employeeNumber, "DEMO-%"))).map((row) => row.number),
  );

  for (const demo of PIZZA_EMPLOYEES) {
    if (existing.has(demo.employeeNumber)) {
      continue;
    }

    const employee = await createEmployee(database, owner, {
      employeeNumber: demo.employeeNumber,
      firstName: demo.firstName,
      middleName: null,
      lastName: demo.lastName,
      preferredName: demo.preferredName ?? null,
      workEmail: workEmail(demo),
      hireDate: demo.hireDate,
      employmentType: demo.employmentType,
      positionId: need(ids, demo.position.code, "position"),
    });

    await updatePersonalContact(database, owner, employee.id, { personalEmail: null, phone: demo.phone, expectedVersion: employee.version });

    const wage = (code: string, effectiveFrom: string, pay: PizzaEmployee["position"]["wage"]) =>
      changeCompensation(database, owner, {
        employeeId: employee.id,
        positionId: need(ids, code, "position"),
        compensationType: pay.type,
        hourlyRate: pay.type === "HOURLY" ? pay.hourlyRate : null,
        annualSalary: pay.type === "SALARY" ? pay.annualSalary : null,
        effectiveFrom,
        changeReason: "Demo data",
      });

    await wage(demo.position.code, demo.hireDate, demo.position.wage);

    for (const secondary of demo.secondary ?? []) {
      const [row] = await database.select({ version: employees.version }).from(employees).where(eq(employees.id, employee.id));

      await assignPosition(database, owner, owner, {
        employeeId: employee.id,
        positionId: need(ids, secondary.code, "position"),
        primaryPosition: false,
        effectiveFrom: secondary.effectiveFrom,
        expectedVersion: row!.version,
      });
      await wage(secondary.code, secondary.effectiveFrom, secondary.wage);
    }

    summary.employees += 1;
  }

  const roster = new Map(
    (
      await database
        .select({ id: employees.id, number: employees.employeeNumber, hireDate: employees.hireDate })
        .from(employees)
        .where(inArray(employees.employeeNumber, PIZZA_EMPLOYEES.map((demo) => demo.employeeNumber)))
    ).map((row) => [row.number, row]),
  );

  // ------------------------------------------------------------ availability
  const configured = new Set(
    (
      await database
        .selectDistinct({ employeeId: employeeAvailability.employeeId })
        .from(employeeAvailability)
        .where(inArray(employeeAvailability.employeeId, [...roster.values()].map((row) => row.id)))
    ).map((row) => row.employeeId),
  );

  for (const demo of PIZZA_EMPLOYEES) {
    const employee = need(roster, demo.employeeNumber, "employee");

    if (configured.has(employee.id)) {
      continue;
    }

    for (const window of AVAILABILITY_PATTERNS[demo.availability] as readonly AvailabilityWindow[]) {
      for (const day of window.days) {
        await addRecurringAvailability(
          database,
          owner,
          { kind: "employee", employeeId: employee.id },
          {
            dayOfWeek: day,
            startTime: window.start,
            endTime: window.end,
            availabilityType: window.type ?? "AVAILABLE",
            effectiveFrom: employee.hireDate,
            effectiveTo: null,
            thisLocationOnly: false,
          },
        );
        summary.availabilityWindows += 1;
      }
    }
  }

  assertCoverage();

  // ----------------------------------------------------------- certifications
  const types = new Map(
    (await database.select({ id: certificationTypes.id, code: certificationTypes.code }).from(certificationTypes).where(eq(certificationTypes.organizationId, owner.organizationId))).map(
      (row) => [row.code, row.id],
    ),
  );
  const certified = new Set(
    (await database.selectDistinct({ employeeId: employeeCertifications.employeeId }).from(employeeCertifications)).map((row) => row.employeeId),
  );

  for (const demo of PIZZA_EMPLOYEES) {
    const employee = need(roster, demo.employeeNumber, "employee");

    if (certified.has(employee.id)) {
      continue;
    }

    for (const [index, certification] of (demo.certifications ?? []).entries()) {
      const expires = addDays(today, certification.expiresInDays);
      const code = await codeOf(
        addCertification(database, owner, employee.id, {
          certificationTypeId: need(types, certification.type, "certification type"),
          certificationNumber: `${certification.type === "FOOD_SAFETY" ? "FS" : "AS"}-${demo.employeeNumber.slice(5)}${index}`,
          issuedDate: addDays(expires, -3 * 365),
          expirationDate: expires,
          documentId: null,
        }),
      );

      if (code === null) {
        summary.certifications += 1;
      }
    }
  }

  // --------------------------------------------------------------- template
  const [template] = await database
    .select({ id: staffingTemplates.id })
    .from(staffingTemplates)
    .where(and(eq(staffingTemplates.locationId, owner.locationId), eq(staffingTemplates.name, PIZZA_TEMPLATE_NAME)));

  if (!template) {
    const created = await createTemplate(database, owner, {
      name: PIZZA_TEMPLATE_NAME,
      description: "Lunch and dinner for the pizza restaurant; longer Friday and Saturday nights.",
    });

    for (const requirement of PIZZA_WEEK) {
      for (const day of requirement.days) {
        await addRequirement(database, owner, created.id, {
          dayOfWeek: day,
          positionId: need(ids, requirement.position, "position"),
          restaurantAreaId: null,
          startTime: requirement.start,
          endTime: requirement.end,
          requiredEmployeeCount: requirement.count,
          priority: 0,
        });
      }
    }

    summary.templateCreated = true;
  }

  // ------------------------------------------------------ ratios and tip pool
  const settings = await getForecastSettings(database, owner);
  const withRatio = new Set(settings.ratios.filter((ratio) => ratio.active).map((ratio) => ratio.positionId));

  for (const ratio of PIZZA_RATIOS) {
    const positionId = need(ids, ratio.positionCode, "position");

    if (!withRatio.has(positionId)) {
      await createRatio(database, owner, {
        positionId,
        measure: ratio.measure,
        unitsPerEmployeeHour: ratio.unitsPerEmployeeHour,
        minimumEmployees: ratio.minimumEmployees,
        maximumEmployees: ratio.maximumEmployees,
      });
      summary.ratios += 1;
    }
  }

  if (!(await readTipRule(database, owner.locationId)).id) {
    await saveTipRule(database, owner, {
      name: "Front of house pool",
      active: true,
      positions: PIZZA_TIP_POOL.map((entry) => ({ positionId: need(ids, entry.position, "position"), points: entry.points })),
      expectedVersion: null,
    });
    summary.tipPool = true;
  }

  return summary;
}

/**
 * Next week's time off (a Sunday-start week after today): one approved vacation the schedule
 * generator works around, one request still waiting. Run with the real clock, before next week's
 * schedule is generated. Skipped for an employee who already has a request.
 */
export async function seedPizzaTimeOff(database: Database, owner: Actor, today: string): Promise<number> {
  let nextWeek = addDays(today, 1);

  while (dayOfWeek(nextWeek) !== 0) {
    nextWeek = addDays(nextWeek, 1);
  }

  let added = 0;

  for (const entry of PIZZA_TIME_OFF) {
    const [employee] = await database.select({ id: employees.id }).from(employees).where(eq(employees.employeeNumber, entry.employeeNumber));

    if (!employee) {
      continue;
    }

    const [already] = await database.select({ id: timeOffRequests.id }).from(timeOffRequests).where(eq(timeOffRequests.employeeId, employee.id)).limit(1);

    if (already) {
      continue;
    }

    const request = await requestTimeOffForEmployee(database, owner, employee.id, {
      startDate: addDays(nextWeek, entry.fromDay),
      startTime: null,
      endDate: addDays(nextWeek, entry.toDay),
      endTime: null,
      requestType: entry.requestType,
      reason: entry.reason,
      employeeNote: null,
    });

    if (entry.approve) {
      const [row] = await database.select({ version: timeOffRequests.version }).from(timeOffRequests).where(eq(timeOffRequests.id, request.id));

      await approveTimeOff(database, owner, request.id, { managerNote: "Approved, enjoy it.", expectedVersion: row!.version });
    }

    added += 1;
  }

  return added;
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Whether one availability window on `day` covers a shift from `start` to `end` that day. */
function covers(window: AvailabilityWindow, day: number, start: string, end: string): boolean {
  if (!window.days.includes(day) || (window.type ?? "AVAILABLE") !== "AVAILABLE") {
    return false;
  }

  const windowEnd = minutes(window.end) <= minutes(window.start) ? minutes(window.end) + 1440 : minutes(window.end);
  const shiftEnd = minutes(end) <= minutes(start) ? minutes(end) + 1440 : minutes(end);

  return minutes(window.start) <= minutes(start) && shiftEnd <= windowEnd;
}

/**
 * Refuses to go on if any slot of the template has fewer eligible people (by position held and
 * availability) than it needs plus one, so generating a schedule can always fill it.
 */
export function assertCoverage(): void {
  const short: string[] = [];

  for (const requirement of PIZZA_WEEK) {
    for (const day of requirement.days) {
      const eligible = PIZZA_EMPLOYEES.filter(
        (demo) =>
          (demo.position.code === requirement.position || (demo.secondary ?? []).some((entry) => entry.code === requirement.position)) &&
          (AVAILABILITY_PATTERNS[demo.availability] as readonly AvailabilityWindow[]).some((window) => covers(window, day, requirement.start, requirement.end)),
      ).length;

      if (eligible < requirement.count + 1) {
        short.push(`${requirement.position} day ${day} ${requirement.start}-${requirement.end}: ${eligible} eligible for ${requirement.count}`);
      }
    }
  }

  // Each day as a whole: every person-slot filled with at most one shift per person per day
  // (a bipartite matching), so people who hold two positions aren't counted twice.
  for (let day = 0; day < 7; day += 1) {
    const slots = PIZZA_WEEK.filter((requirement) => requirement.days.includes(day)).flatMap((requirement) =>
      Array.from({ length: requirement.count }, () => requirement),
    );
    const eligible = slots.map((requirement) =>
      PIZZA_EMPLOYEES.flatMap((demo, index) =>
        (demo.position.code === requirement.position || (demo.secondary ?? []).some((entry) => entry.code === requirement.position)) &&
        (AVAILABILITY_PATTERNS[demo.availability] as readonly AvailabilityWindow[]).some((window) => covers(window, day, requirement.start, requirement.end))
          ? [index]
          : [],
      ),
    );
    const holder = new Map<number, number>();
    const assign = (slot: number, seen: Set<number>): boolean => {
      for (const person of eligible[slot]!) {
        if (seen.has(person)) {
          continue;
        }

        seen.add(person);

        const current = holder.get(person);

        if (current === undefined || assign(current, seen)) {
          holder.set(person, slot);

          return true;
        }
      }

      return false;
    };
    const unfilled = slots.filter((_, slot) => !assign(slot, new Set()));

    if (unfilled.length > 0) {
      short.push(`day ${day}: no one left for ${unfilled.map((requirement) => `${requirement.position} ${requirement.start}-${requirement.end}`).join(", ")}`);
    }
  }

  if (short.length > 0) {
    throw new Error(`The demo roster can't cover "${PIZZA_TEMPLATE_NAME}":\n  ${short.join("\n  ")}`);
  }
}
