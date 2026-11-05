import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { employeePositionCompensation as compensation } from "@/db/schema";
import { assignPosition } from "@/modules/employees/services/assignment-service";
import {
  changeCompensation,
  getCompensationHistory,
} from "@/modules/employees/services/compensation-service";
import { terminateEmployee } from "@/workflows/terminate-employee/terminate-employee";
import { AuthorizationError, ValidationError } from "@/shared/errors/app-error";

import {
  actorWith,
  clearEmployeeData,
  createEmployeeFixture,
  createHrScenario,
  type HrScenario,
} from "../../fixtures/employee-fixtures";

const database = () => getDatabase();

describe("position compensation", () => {
  let scenario: HrScenario;

  beforeAll(async () => {
    scenario = await createHrScenario(database());
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  /** An employee holding the Server and Bartender positions since 2024-02-01. */
  async function createTwoPositionEmployee(): Promise<string> {
    const { id } = await createEmployeeFixture(database(), scenario.owner);

    for (const [index, positionId] of [
      scenario.server,
      scenario.bartender,
    ].entries()) {
      await assignPosition(database(), scenario.owner, scenario.owner, {
        employeeId: id,
        positionId,
        primaryPosition: false,
        effectiveFrom: "2024-02-01",
        expectedVersion: index + 1,
      });
    }

    return id;
  }

  const hourly = (
    employeeId: string,
    positionId: string,
    hourlyRate: string,
    effectiveFrom: string,
  ) =>
    changeCompensation(database(), scenario.owner, {
      employeeId,
      positionId,
      compensationType: "HOURLY",
      hourlyRate,
      annualSalary: null,
      effectiveFrom,
      changeReason: null,
    });

  const historyFor = async (employeeId: string, positionId: string) =>
    (await getCompensationHistory(database(), scenario.owner, employeeId))
      .filter((period) => period.positionId === positionId)
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

  it("creates an initial hourly wage for an employee and position", async () => {
    const id = await createTwoPositionEmployee();

    await hourly(id, scenario.server, "9.50", "2024-02-01");

    expect(await historyFor(id, scenario.server)).toMatchObject([
      {
        compensationType: "HOURLY",
        hourlyRate: "9.50",
        annualSalary: null,
        effectiveFrom: "2024-02-01",
        effectiveTo: null,
      },
    ]);
  });

  it("closes the prior period the day before, keeping its amount", async () => {
    const id = await createTwoPositionEmployee();

    await hourly(id, scenario.server, "9.50", "2024-02-01");
    await hourly(id, scenario.server, "10.25", "2024-03-01");

    expect(await historyFor(id, scenario.server)).toMatchObject([
      { hourlyRate: "9.50", effectiveFrom: "2024-02-01", effectiveTo: "2024-02-29" },
      { hourlyRate: "10.25", effectiveFrom: "2024-03-01", effectiveTo: null },
    ]);
  });

  it("holds independent wages for two positions of one employee", async () => {
    const id = await createTwoPositionEmployee();

    await hourly(id, scenario.server, "9.50", "2024-02-01");
    await hourly(id, scenario.bartender, "12.00", "2024-02-15");

    expect((await historyFor(id, scenario.server))[0]?.hourlyRate).toBe("9.50");
    expect((await historyFor(id, scenario.bartender))[0]?.hourlyRate).toBe("12.00");
  });

  it("changing one position's wage leaves the other unchanged", async () => {
    const id = await createTwoPositionEmployee();

    await hourly(id, scenario.server, "9.50", "2024-02-01");
    await hourly(id, scenario.bartender, "12.00", "2024-02-01");
    await hourly(id, scenario.server, "11.00", "2024-05-01");

    expect(await historyFor(id, scenario.bartender)).toMatchObject([
      { hourlyRate: "12.00", effectiveTo: null },
    ]);
  });

  it("lets two employees in one position hold different wages", async () => {
    const first = await createTwoPositionEmployee();
    const second = await createTwoPositionEmployee();

    await hourly(first, scenario.server, "9.50", "2024-02-01");
    await hourly(second, scenario.server, "11.25", "2024-02-01");

    expect((await historyFor(first, scenario.server))[0]?.hourlyRate).toBe("9.50");
    expect((await historyFor(second, scenario.server))[0]?.hourlyRate).toBe("11.25");
  });

  it("rejects a position the employee was never assigned", async () => {
    const { id } = await createEmployeeFixture(database(), scenario.owner);

    await expect(
      hourly(id, scenario.server, "9.50", "2024-02-01"),
    ).rejects.toMatchObject({ code: "POSITION_NOT_ASSIGNED" });
  });

  it("rejects a date before the assignment starts", async () => {
    const id = await createTwoPositionEmployee();

    await expect(
      hourly(id, scenario.server, "9.50", "2024-01-20"),
    ).rejects.toMatchObject({ code: "POSITION_NOT_ASSIGNED" });
  });

  it("rejects a position from another organization", async () => {
    const other = await createHrScenario(database());
    const id = await createTwoPositionEmployee();

    await expect(
      hourly(id, other.server, "9.50", "2024-02-01"),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("validates a salary record", async () => {
    const id = await createTwoPositionEmployee();

    await changeCompensation(database(), scenario.owner, {
      employeeId: id,
      positionId: scenario.server,
      compensationType: "SALARY",
      hourlyRate: null,
      annualSalary: "52000.00",
      effectiveFrom: "2024-02-01",
      changeReason: "Promotion",
    });

    expect(await historyFor(id, scenario.server)).toMatchObject([
      {
        compensationType: "SALARY",
        annualSalary: "52000.00",
        hourlyRate: null,
        changeReason: "Promotion",
      },
    ]);
  });

  it.each([
    { compensationType: "HOURLY", hourlyRate: "9.50", annualSalary: "1.00" },
    { compensationType: "HOURLY", hourlyRate: null, annualSalary: "1.00" },
    { compensationType: "SALARY", hourlyRate: "9.50", annualSalary: null },
    { compensationType: "HOURLY", hourlyRate: "-1.00", annualSalary: null },
    { compensationType: "HOURLY", hourlyRate: "9.505", annualSalary: null },
  ] as const)("rejects invalid amounts %o", async (amounts) => {
    const id = await createTwoPositionEmployee();

    await expect(
      changeCompensation(database(), scenario.owner, {
        ...amounts,
        employeeId: id,
        positionId: scenario.server,
        effectiveFrom: "2024-02-01",
        changeReason: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects mixed values at the database level too", async () => {
    const id = await createTwoPositionEmployee();

    await expect(
      database().insert(compensation).values({
        organizationId: scenario.organizationId,
        employeeId: id,
        positionId: scenario.server,
        compensationType: "HOURLY",
        hourlyRate: "9.50",
        annualSalary: "1.00",
        effectiveFrom: "2024-02-01",
        createdByUserId: scenario.owner.userId,
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("rejects a row whose organization doesn't match its employee", async () => {
    const other = await createHrScenario(database());
    const id = await createTwoPositionEmployee();

    await expect(
      database().insert(compensation).values({
        organizationId: other.organizationId,
        employeeId: id,
        positionId: scenario.server,
        compensationType: "HOURLY",
        hourlyRate: "9.50",
        effectiveFrom: "2024-02-01",
        createdByUserId: scenario.owner.userId,
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("rejects a date not after the current wage's start, changing nothing", async () => {
    const id = await createTwoPositionEmployee();

    await hourly(id, scenario.server, "9.50", "2024-03-01");

    for (const date of ["2024-03-01", "2024-02-15"]) {
      await expect(
        hourly(id, scenario.server, "10.00", date),
      ).rejects.toMatchObject({ code: "COMPENSATION_OVERLAP" });
    }

    expect(await historyFor(id, scenario.server)).toMatchObject([
      { hourlyRate: "9.50", effectiveTo: null },
    ]);
  });

  it("rejects an overlapping row inserted directly for the same pair", async () => {
    const id = await createTwoPositionEmployee();

    await hourly(id, scenario.server, "9.50", "2024-02-01");

    await expect(
      database().insert(compensation).values({
        organizationId: scenario.organizationId,
        employeeId: id,
        positionId: scenario.server,
        compensationType: "HOURLY",
        hourlyRate: "1.00",
        effectiveFrom: "2024-06-01",
        createdByUserId: scenario.owner.userId,
      }),
    ).rejects.toMatchObject({ cause: { code: "23P01" } });
  });

  it("serializes simultaneous changes, leaving a consistent history", async () => {
    const id = await createTwoPositionEmployee();

    await hourly(id, scenario.server, "9.50", "2024-02-01");

    const results = await Promise.allSettled([
      hourly(id, scenario.server, "10.00", "2024-03-01"),
      hourly(id, scenario.server, "11.00", "2024-03-01"),
    ]);
    const history = await historyFor(id, scenario.server);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(history).toHaveLength(2);
    expect(history.filter((period) => period.effectiveTo === null)).toHaveLength(1);
  });

  it("preserves exact decimal strings at the column limit", async () => {
    const id = await createTwoPositionEmployee();

    await changeCompensation(database(), scenario.owner, {
      employeeId: id,
      positionId: scenario.server,
      compensationType: "SALARY",
      hourlyRate: null,
      annualSalary: "9999999999.99",
      effectiveFrom: "2024-02-01",
      changeReason: null,
    });
    await hourly(id, scenario.bartender, "0.10", "2024-02-01");

    const server = await historyFor(id, scenario.server);
    const bartender = await historyFor(id, scenario.bartender);

    expect(server[0]?.annualSalary).toBe("9999999999.99");
    expect(typeof server[0]?.annualSalary).toBe("string");
    expect(bartender[0]?.hourlyRate).toBe("0.10");
  });

  it("keeps history after the position ends or the employee is terminated", async () => {
    const id = await createTwoPositionEmployee();

    await hourly(id, scenario.server, "9.50", "2024-02-01");
    await terminateEmployee(database(), scenario.owner, {
      employeeId: id,
      terminationDate: "2024-06-30",
      reason: null,
      expectedVersion: 3,
    });

    expect(await historyFor(id, scenario.server)).toHaveLength(1);
    await expect(
      hourly(id, scenario.server, "10.00", "2024-06-01"),
    ).rejects.toMatchObject({ code: "EMPLOYEE_TERMINATED" });
  });

  it("denies an unauthorized read and write, including employees.view alone", async () => {
    const id = await createTwoPositionEmployee();
    const viewer = await actorWith(database(), scenario, [
      "employees.view",
      "employees.edit",
      "hr.view",
    ]);
    const readOnly = await actorWith(database(), scenario, [
      "hr.compensation.view",
    ]);

    await expect(
      getCompensationHistory(database(), viewer, id),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      changeCompensation(database(), viewer, {
        employeeId: id,
        positionId: scenario.server,
        compensationType: "HOURLY",
        hourlyRate: "9.50",
        annualSalary: null,
        effectiveFrom: "2024-02-01",
        changeReason: null,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      changeCompensation(database(), readOnly, {
        employeeId: id,
        positionId: scenario.server,
        compensationType: "HOURLY",
        hourlyRate: "9.50",
        annualSalary: null,
        effectiveFrom: "2024-02-01",
        changeReason: null,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      getCompensationHistory(database(), readOnly, id),
    ).resolves.toEqual([]);
  });

  it("writes no history row when the change is refused", async () => {
    const id = await createTwoPositionEmployee();
    const viewer = await actorWith(database(), scenario, ["employees.view"]);

    await changeCompensation(database(), viewer, {
      employeeId: id,
      positionId: scenario.server,
      compensationType: "HOURLY",
      hourlyRate: "9.50",
      annualSalary: null,
      effectiveFrom: "2024-02-01",
      changeReason: null,
    }).catch(() => undefined);

    const rows = await database()
      .select()
      .from(compensation)
      .where(eq(compensation.employeeId, id));

    expect(rows).toEqual([]);
  });
});
