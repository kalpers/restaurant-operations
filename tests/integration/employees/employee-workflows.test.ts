import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  employeeLocations,
  employeePositions,
  employees,
  employeeStatusHistory,
  userRoles,
  users,
} from "@/db/schema";
import { getUserAuthContext } from "@/modules/auth/services/permission-service";
import { assignRole } from "@/modules/auth/services/user-service";
import {
  assignLocation,
  assignPosition,
  endLocationAssignment,
  endPositionAssignment,
  setPrimaryLocation,
  setPrimaryPosition,
} from "@/modules/employees/services/assignment-service";
import {
  getEmployeeGeneral,
  listEmployees,
  updateEmployeeGeneral,
} from "@/modules/employees/services/employee-service";
import {
  createPosition,
  updatePosition,
} from "@/modules/employees/services/reference-service";
import {
  changeEmployeeStatus,
  getEmployeeEmployment,
} from "@/modules/employees/services/status-service";
import { linkUser } from "@/modules/employees/services/user-link-service";
import {
  AuthorizationError,
  NotFoundError,
} from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { createUserFixture } from "../../fixtures/auth-fixtures";
import {
  actorWith,
  clearEmployeeData,
  createEmployeeFixture,
  createHrScenario,
  createPositionFixture,
  HIRE_DATE,
  uniqueEmployeeNumber,
  type HrScenario,
} from "../../fixtures/employee-fixtures";

const database = () => getDatabase();

describe("employee workflows", () => {
  let scenario: HrScenario;

  beforeAll(async () => {
    scenario = await createHrScenario(database());
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  describe("creation", () => {
    it("creates the employee, initial location and status history atomically", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      const [row] = await database()
        .select()
        .from(employees)
        .where(eq(employees.id, id));
      const locations = await database()
        .select()
        .from(employeeLocations)
        .where(eq(employeeLocations.employeeId, id));
      const history = await database()
        .select()
        .from(employeeStatusHistory)
        .where(eq(employeeStatusHistory.employeeId, id));

      expect(row).toMatchObject({
        employmentStatus: "ACTIVE",
        primaryLocationId: scenario.locationA,
        userId: null,
        version: 1,
      });
      expect(locations).toHaveLength(1);
      expect(locations[0]).toMatchObject({
        locationId: scenario.locationA,
        primaryLocation: true,
        effectiveFrom: HIRE_DATE,
        active: true,
      });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        status: "ACTIVE",
        changedByUserId: scenario.owner.userId,
      });
    });

    it("assigns an optional initial position as primary", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner, {
        positionId: scenario.server,
      });
      const detail = await getEmployeeGeneral(database(), scenario.owner, id);

      expect(detail.positions).toHaveLength(1);
      expect(detail.positions[0]).toMatchObject({
        positionId: scenario.server,
        locationId: scenario.locationA,
        primaryPosition: true,
      });
    });

    it("never creates a user", async () => {
      const before = await database().select({ id: users.id }).from(users);

      await createEmployeeFixture(database(), scenario.owner);

      const after = await database().select({ id: users.id }).from(users);

      expect(after).toHaveLength(before.length);
    });

    it("rolls back everything when the initial position is invalid", async () => {
      const employeeNumber = uniqueEmployeeNumber();
      const other = await createHrScenario(database());

      await expect(
        createEmployeeFixture(database(), scenario.owner, {
          employeeNumber,
          positionId: other.server,
        }),
      ).rejects.toMatchObject({ httpStatus: 400 });

      const rows = await database()
        .select({ id: employees.id })
        .from(employees)
        .where(eq(employees.employeeNumber, employeeNumber));

      expect(rows).toEqual([]);
    });

    it("rejects a duplicate number within the organization only", async () => {
      const employeeNumber = uniqueEmployeeNumber();
      const other = await createHrScenario(database());

      await createEmployeeFixture(database(), scenario.owner, { employeeNumber });

      await expect(
        createEmployeeFixture(database(), scenario.owner, { employeeNumber }),
      ).rejects.toMatchObject({ code: "EMPLOYEE_NUMBER_EXISTS", httpStatus: 409 });
      await expect(
        createEmployeeFixture(database(), other.owner, { employeeNumber }),
      ).resolves.toBeDefined();
    });

    it("needs employees.create, and positions.manage for an initial position", async () => {
      const viewer = await actorWith(database(), scenario, ["employees.view"]);
      const creator = await actorWith(database(), scenario, ["employees.create"]);

      await expect(
        createEmployeeFixture(database(), viewer),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        createEmployeeFixture(database(), creator, {
          positionId: scenario.server,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        createEmployeeFixture(database(), creator),
      ).resolves.toBeDefined();
    });
  });

  describe("general access", () => {
    it("lets employees.view retrieve the general summary", async () => {
      const viewer = await actorWith(database(), scenario, ["employees.view"]);
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      const listed = await listEmployees(database(), viewer);
      const detail = await getEmployeeGeneral(database(), viewer, id);

      expect(listed.map((row) => row.id)).toContain(id);
      expect(detail.id).toBe(id);
    });

    it("denies an actor with no employee permission", async () => {
      const outsider = await actorWith(database(), scenario, ["orders.create"]);
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await expect(listEmployees(database(), outsider)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      await expect(
        getEmployeeGeneral(database(), outsider, id),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("treats another organization's employee as not found", async () => {
      const other = await createHrScenario(database());
      const { id } = await createEmployeeFixture(database(), other.owner);

      await expect(
        getEmployeeGeneral(database(), scenario.owner, id),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(
        (await listEmployees(database(), scenario.owner)).map((row) => row.id),
      ).not.toContain(id);
    });

    it("treats an employee who never worked at this location as not found", async () => {
      const atB = await actorWith(
        database(),
        scenario,
        ["employees.view"],
        scenario.locationB,
      );
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await expect(
        getEmployeeGeneral(database(), atB, id),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("updates general fields with employees.edit", async () => {
      const editor = await actorWith(database(), scenario, ["employees.edit"]);
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await updateEmployeeGeneral(database(), editor, id, {
        firstName: "Janet",
        middleName: null,
        lastName: "Smith",
        preferredName: "JJ",
        workEmail: null,
        employmentType: "FULL_TIME",
        expectedVersion: 1,
      });

      const detail = await getEmployeeGeneral(database(), scenario.owner, id);

      expect(detail).toMatchObject({
        firstName: "Janet",
        preferredName: "JJ",
        employmentType: "FULL_TIME",
        version: 2,
      });
    });

    it("rejects a stale update without overwriting", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);
      const fields = {
        middleName: null,
        lastName: "Smith",
        preferredName: null,
        workEmail: null,
        employmentType: "PART_TIME",
      };

      await updateEmployeeGeneral(database(), scenario.owner, id, {
        ...fields,
        firstName: "First",
        expectedVersion: 1,
      });

      await expect(
        updateEmployeeGeneral(database(), scenario.owner, id, {
          ...fields,
          firstName: "Second",
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);

      expect(
        (await getEmployeeGeneral(database(), scenario.owner, id)).firstName,
      ).toBe("First");
    });

    it("lets exactly one of two simultaneous updates win", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);
      const update = (firstName: string) =>
        updateEmployeeGeneral(database(), scenario.owner, id, {
          firstName,
          middleName: null,
          lastName: "Smith",
          preferredName: null,
          workEmail: null,
          employmentType: "PART_TIME",
          expectedVersion: 1,
        });

      const results = await Promise.allSettled([update("A"), update("B")]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    });
  });

  describe("locations", () => {
    it("adds another eligible location while the primary stays", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await assignLocation(database(), scenario.owner, scenario.ownerAtB, {
        employeeId: id,
        effectiveFrom: "2024-02-01",
        expectedVersion: 1,
      });

      const detail = await getEmployeeGeneral(database(), scenario.owner, id);

      expect(detail.locations).toHaveLength(2);
      expect(detail.primaryLocationId).toBe(scenario.locationA);
      expect(detail.version).toBe(2);
    });

    it("needs the permission at the target location too", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);
      const localOnly = await actorWith(database(), scenario, [
        "employees.locations.manage",
      ]);
      const viewerAtB = await actorWith(
        database(),
        scenario,
        ["employees.view"],
        scenario.locationB,
      );

      await expect(
        assignLocation(database(), localOnly, viewerAtB, {
          employeeId: id,
          effectiveFrom: "2024-02-01",
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("rejects a location from another organization", async () => {
      const other = await createHrScenario(database());
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await expect(
        assignLocation(database(), scenario.owner, other.owner, {
          employeeId: id,
          effectiveFrom: "2024-02-01",
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("rejects an overlapping assignment at the same location", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await expect(
        assignLocation(database(), scenario.owner, scenario.owner, {
          employeeId: id,
          effectiveFrom: "2024-06-01",
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: "ASSIGNMENT_OVERLAP", httpStatus: 409 });
    });

    it("moves the primary flag and the employee's column together", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);
      const added = await assignLocation(
        database(),
        scenario.owner,
        scenario.ownerAtB,
        { employeeId: id, effectiveFrom: "2024-02-01", expectedVersion: 1 },
      );

      await setPrimaryLocation(database(), scenario.owner, {
        employeeId: id,
        assignmentId: added.id,
        expectedVersion: 2,
      });

      const detail = await getEmployeeGeneral(database(), scenario.owner, id);
      const primaries = detail.locations.filter((row) => row.primaryLocation);

      expect(primaries).toHaveLength(1);
      expect(primaries[0]?.locationId).toBe(scenario.locationB);
      expect(detail.primaryLocationId).toBe(scenario.locationB);
    });

    it("won't end a primary location, or one with active positions", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);
      const { locations } = await getEmployeeGeneral(
        database(),
        scenario.owner,
        id,
      );

      await expect(
        endLocationAssignment(database(), scenario.owner, {
          employeeId: id,
          assignmentId: locations[0]!.id,
          effectiveTo: "2024-03-01",
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: "PRIMARY_LOCATION_REQUIRED" });

      const added = await assignLocation(
        database(),
        scenario.owner,
        scenario.ownerAtB,
        { employeeId: id, effectiveFrom: "2024-02-01", expectedVersion: 1 },
      );

      await assignPosition(database(), scenario.owner, scenario.ownerAtB, {
        employeeId: id,
        positionId: scenario.server,
        primaryPosition: false,
        effectiveFrom: "2024-02-01",
        expectedVersion: 2,
      });

      await expect(
        endLocationAssignment(database(), scenario.owner, {
          employeeId: id,
          assignmentId: added.id,
          effectiveTo: "2024-03-01",
          expectedVersion: 3,
        }),
      ).rejects.toMatchObject({ code: "LOCATION_HAS_ACTIVE_POSITIONS" });
    });

    it("keeps an ended assignment as history, and allows the location again later", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);
      const added = await assignLocation(
        database(),
        scenario.owner,
        scenario.ownerAtB,
        { employeeId: id, effectiveFrom: "2024-02-01", expectedVersion: 1 },
      );

      await endLocationAssignment(database(), scenario.owner, {
        employeeId: id,
        assignmentId: added.id,
        effectiveTo: "2024-03-01",
        expectedVersion: 2,
      });

      const rows = await database()
        .select()
        .from(employeeLocations)
        .where(eq(employeeLocations.id, added.id));

      expect(rows[0]).toMatchObject({ active: false, effectiveTo: "2024-03-01" });

      await expect(
        assignLocation(database(), scenario.owner, scenario.ownerAtB, {
          employeeId: id,
          effectiveFrom: "2024-03-02",
          expectedVersion: 3,
        }),
      ).resolves.toBeDefined();
    });

    it("rejects an end date in the future", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);
      const added = await assignLocation(
        database(),
        scenario.owner,
        scenario.ownerAtB,
        { employeeId: id, effectiveFrom: "2024-02-01", expectedVersion: 1 },
      );

      await expect(
        endLocationAssignment(database(), scenario.owner, {
          employeeId: id,
          assignmentId: added.id,
          effectiveTo: "2099-01-01",
          expectedVersion: 2,
        }),
      ).rejects.toMatchObject({ code: "END_DATE_IN_FUTURE" });
    });
  });

  describe("positions", () => {
    it("assigns several positions at an eligible location", async () => {
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

      const detail = await getEmployeeGeneral(database(), scenario.owner, id);

      expect(detail.positions.map((row) => row.positionId).sort()).toEqual(
        [scenario.server, scenario.bartender].sort(),
      );
    });

    it("rejects a location where the employee isn't eligible", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await expect(
        assignPosition(database(), scenario.owner, scenario.ownerAtB, {
          employeeId: id,
          positionId: scenario.server,
          primaryPosition: false,
          effectiveFrom: "2024-02-01",
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: "LOCATION_NOT_ELIGIBLE" });
    });

    it("rejects a start before the employee is eligible or hired", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await expect(
        assignPosition(database(), scenario.owner, scenario.owner, {
          employeeId: id,
          positionId: scenario.server,
          primaryPosition: false,
          effectiveFrom: "2020-01-01",
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: "ASSIGNMENT_BEFORE_HIRE" });
    });

    it("rejects a position from another organization and an inactive one", async () => {
      const other = await createHrScenario(database());
      const inactive = await createPositionFixture(
        database(),
        scenario.organizationId,
      );
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await updatePosition(database(), scenario.owner, {
        positionId: inactive,
        name: "Retired",
        description: null,
        active: false,
        expectedVersion: 1,
      });

      for (const positionId of [other.server, inactive]) {
        await expect(
          assignPosition(database(), scenario.owner, scenario.owner, {
            employeeId: id,
            positionId,
            primaryPosition: false,
            effectiveFrom: "2024-02-01",
            expectedVersion: 1,
          }),
        ).rejects.toMatchObject({ httpStatus: 400 });
      }
    });

    it("rejects a duplicate overlapping assignment", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner, {
        positionId: scenario.server,
      });

      await expect(
        assignPosition(database(), scenario.owner, scenario.owner, {
          employeeId: id,
          positionId: scenario.server,
          primaryPosition: false,
          effectiveFrom: "2024-03-01",
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: "ASSIGNMENT_OVERLAP" });
    });

    it("keeps one primary position per location", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner, {
        positionId: scenario.server,
      });
      const added = await assignPosition(
        database(),
        scenario.owner,
        scenario.owner,
        {
          employeeId: id,
          positionId: scenario.bartender,
          primaryPosition: true,
          effectiveFrom: "2024-02-01",
          expectedVersion: 1,
        },
      );

      let detail = await getEmployeeGeneral(database(), scenario.owner, id);
      const primaryIds = () =>
        detail.positions.filter((row) => row.primaryPosition).map((row) => row.id);

      expect(primaryIds()).toEqual([added.id]);

      const original = detail.positions.find(
        (row) => row.positionId === scenario.server,
      )!;

      await setPrimaryPosition(database(), scenario.owner, {
        employeeId: id,
        assignmentId: original.id,
        expectedVersion: 2,
      });

      detail = await getEmployeeGeneral(database(), scenario.owner, id);
      expect(primaryIds()).toEqual([original.id]);
    });

    it("preserves an ended assignment as history, visible with hr.view only", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner, {
        positionId: scenario.server,
      });
      const viewer = await actorWith(database(), scenario, ["employees.view"]);
      const { positions } = await getEmployeeGeneral(
        database(),
        scenario.owner,
        id,
      );

      await endPositionAssignment(database(), scenario.owner, {
        employeeId: id,
        assignmentId: positions[0]!.id,
        effectiveTo: "2024-06-30",
        expectedVersion: 1,
      });

      expect(
        (await getEmployeeGeneral(database(), viewer, id)).positions,
      ).toEqual([]);
      expect(
        (await getEmployeeGeneral(database(), scenario.owner, id)).positions[0],
      ).toMatchObject({ active: false, effectiveTo: "2024-06-30" });
    });

    it("deactivating a position leaves existing assignments in place", async () => {
      const positionId = await createPositionFixture(
        database(),
        scenario.organizationId,
      );
      const { id } = await createEmployeeFixture(database(), scenario.owner, {
        positionId,
      });

      await updatePosition(database(), scenario.owner, {
        positionId,
        name: "Retired",
        description: null,
        active: false,
        expectedVersion: 1,
      });

      expect(
        (await getEmployeeGeneral(database(), scenario.owner, id)).positions,
      ).toHaveLength(1);
    });

    it("rejects a stale employee version", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await expect(
        assignPosition(database(), scenario.owner, scenario.owner, {
          employeeId: id,
          positionId: scenario.server,
          primaryPosition: false,
          effectiveFrom: "2024-02-01",
          expectedVersion: 99,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
    });

    it("rejects a duplicate position code, scoped to the organization", async () => {
      const other = await createHrScenario(database());
      const input = { code: "SOMMELIER", name: "Sommelier", description: null };

      await createPosition(database(), scenario.owner, input);

      await expect(
        createPosition(database(), scenario.owner, input),
      ).rejects.toMatchObject({ code: "CODE_ALREADY_EXISTS" });
      await expect(
        createPosition(database(), other.owner, input),
      ).resolves.toBeDefined();
    });
  });

  describe("status", () => {
    it("appends history for each change and keeps the old rows", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await changeEmployeeStatus(database(), scenario.owner, {
        employeeId: id,
        status: "ON_LEAVE",
        reason: "Leave",
        expectedVersion: 1,
      });
      await changeEmployeeStatus(database(), scenario.owner, {
        employeeId: id,
        status: "ACTIVE",
        reason: null,
        expectedVersion: 2,
      });

      const employment = await getEmployeeEmployment(
        database(),
        scenario.owner,
        id,
      );

      expect(employment.employmentStatus).toBe("ACTIVE");
      expect(employment.statusHistory.map((row) => row.status).sort()).toEqual([
        "ACTIVE",
        "ACTIVE",
        "ON_LEAVE",
      ]);
    });

    it("won't terminate through the ordinary path", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await expect(
        changeEmployeeStatus(database(), scenario.owner, {
          employeeId: id,
          status: "TERMINATED",
          reason: null,
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: "USE_TERMINATION_WORKFLOW" });
    });

    it("rolls back the history row when the version is stale", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await expect(
        changeEmployeeStatus(database(), scenario.owner, {
          employeeId: id,
          status: "SUSPENDED",
          reason: null,
          expectedVersion: 99,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);

      const history = await database()
        .select()
        .from(employeeStatusHistory)
        .where(eq(employeeStatusHistory.employeeId, id));

      expect(history).toHaveLength(1);
    });
  });

  describe("positions and security roles stay independent", () => {
    it("changing a position changes no role or permission", async () => {
      const user = await createUserFixture(database(), {
        assignments: [
          { roleId: scenario.serverRole, locationId: scenario.locationA },
        ],
      });
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await linkUser(database(), scenario.owner, {
        employeeId: id,
        userId: user.id,
        expectedVersion: 1,
      });

      const before = await getUserAuthContext(database(), user.id);

      await assignPosition(database(), scenario.owner, scenario.owner, {
        employeeId: id,
        positionId: scenario.bartender,
        primaryPosition: true,
        effectiveFrom: "2024-02-01",
        expectedVersion: 2,
      });

      expect(await getUserAuthContext(database(), user.id)).toEqual(before);

      const assignments = await database()
        .select()
        .from(userRoles)
        .where(eq(userRoles.userId, user.id));

      expect(assignments).toHaveLength(1);
    });

    it("changing a role creates or changes no position", async () => {
      const user = await createUserFixture(database(), {
        assignments: [
          { roleId: scenario.serverRole, locationId: scenario.locationA },
        ],
      });
      const { id } = await createEmployeeFixture(database(), scenario.owner, {
        positionId: scenario.server,
      });

      await linkUser(database(), scenario.owner, {
        employeeId: id,
        userId: user.id,
        expectedVersion: 1,
      });

      const before = await database()
        .select()
        .from(employeePositions)
        .where(eq(employeePositions.employeeId, id));

      await assignRole(database(), scenario.owner, {
        userId: user.id,
        roleId: scenario.ownerRole,
      });

      expect(
        await database()
          .select()
          .from(employeePositions)
          .where(eq(employeePositions.employeeId, id)),
      ).toEqual(before);
    });

    it("an employee with a position and no login has no access", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner, {
        positionId: scenario.server,
      });
      const [row] = await database()
        .select({ userId: employees.userId })
        .from(employees)
        .where(eq(employees.id, id));

      expect(row?.userId).toBeNull();
    });
  });

  describe("database integrity", () => {
    it("refuses an invalid status, type or termination state directly", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);
      const code = (promise: PromiseLike<unknown>) =>
        Promise.resolve(promise).then(
          () => "none",
          (error: { cause?: { code?: string } }) => error.cause?.code,
        );

      expect(
        await code(
          database()
            .update(employees)
            .set({ employmentStatus: "RETIRED" })
            .where(eq(employees.id, id)),
        ),
      ).toBe("23514");
      expect(
        await code(
          database()
            .update(employees)
            .set({ employmentType: "CONTRACTOR" })
            .where(eq(employees.id, id)),
        ),
      ).toBe("23514");
      expect(
        await code(
          database()
            .update(employees)
            .set({ employmentStatus: "TERMINATED" })
            .where(eq(employees.id, id)),
        ),
      ).toBe("23514");
    });

    it("refuses overlapping location rows inserted directly", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await expect(
        database().insert(employeeLocations).values({
          employeeId: id,
          locationId: scenario.locationA,
          effectiveFrom: "2030-01-01",
        }),
      ).rejects.toMatchObject({ cause: { code: "23P01" } });
    });

    it("refuses deleting an employee with history", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await expect(
        database().delete(employees).where(eq(employees.id, id)),
      ).rejects.toMatchObject({ cause: { code: "23503" } });
    });
  });
});
