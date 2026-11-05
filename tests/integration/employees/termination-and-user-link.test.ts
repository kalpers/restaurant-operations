import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  employeeLocations,
  employeePositions,
  employees,
  employeeStatusHistory,
} from "@/db/schema";
import { getUserAuthContext } from "@/modules/auth/services/permission-service";
import { setUserActive } from "@/modules/auth/services/user-service";
import { assignLocation } from "@/modules/employees/services/assignment-service";
import { getEmployeeEmployment } from "@/modules/employees/services/status-service";
import {
  getLinkedUser,
  linkUser,
  unlinkUser,
} from "@/modules/employees/services/user-link-service";
import { AuthorizationError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";
import { terminateEmployee } from "@/workflows/terminate-employee/terminate-employee";

import {
  actorAt,
  createOrganizationFixture,
  createRoleFixture,
  createUserFixture,
  findUserRow,
} from "../../fixtures/auth-fixtures";
import {
  ABSENT_ID,
  actorWith,
  clearEmployeeData,
  createEmployeeFixture,
  createHrScenario,
  type HrScenario,
} from "../../fixtures/employee-fixtures";

const database = () => getDatabase();

describe("user links and termination", () => {
  let scenario: HrScenario;

  beforeAll(async () => {
    scenario = await createHrScenario(database());
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  const createServerUser = () =>
    createUserFixture(database(), {
      assignments: [
        { roleId: scenario.serverRole, locationId: scenario.locationA },
      ],
    });

  async function createLinkedEmployee() {
    const user = await createServerUser();
    const { id } = await createEmployeeFixture(database(), scenario.owner);

    await linkUser(database(), scenario.owner, {
      employeeId: id,
      userId: user.id,
      expectedVersion: 1,
    });

    return { user, employeeId: id };
  }

  const terminate = (
    actor: HrScenario["owner"],
    employeeId: string,
    expectedVersion = 2,
    terminationDate = "2024-06-30",
  ) =>
    terminateEmployee(database(), actor, {
      employeeId,
      terminationDate,
      reason: "Fixture",
      expectedVersion,
    });

  describe("linking", () => {
    it("links an employee to an available user", async () => {
      const { user, employeeId } = await createLinkedEmployee();

      expect(
        await getLinkedUser(database(), scenario.owner, employeeId),
      ).toEqual({ id: user.id, email: user.email });
    });

    it("rejects linking the same employee to a second user", async () => {
      const { employeeId } = await createLinkedEmployee();
      const second = await createServerUser();

      await expect(
        linkUser(database(), scenario.owner, {
          employeeId,
          userId: second.id,
          expectedVersion: 2,
        }),
      ).rejects.toMatchObject({ code: "EMPLOYEE_ALREADY_LINKED" });
    });

    it("rejects linking an already-linked user to a second employee", async () => {
      const { user } = await createLinkedEmployee();
      const { id: second } = await createEmployeeFixture(
        database(),
        scenario.owner,
      );

      await expect(
        linkUser(database(), scenario.owner, {
          employeeId: second,
          userId: user.id,
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: "USER_ALREADY_LINKED", httpStatus: 409 });
    });

    it("rejects a user from another organization", async () => {
      const other = await createOrganizationFixture(database());
      const outsider = await createUserFixture(database(), {
        assignments: [{ roleId: other.serverRole, locationId: other.locationA }],
      });
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await expect(
        linkUser(database(), scenario.owner, {
          employeeId: id,
          userId: outsider.id,
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects an unknown user", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await expect(
        linkUser(database(), scenario.owner, {
          employeeId: id,
          userId: ABSENT_ID,
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("needs both employees.edit and admin.users.manage", async () => {
      const user = await createServerUser();
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      for (const granted of [
        ["employees.view", "employees.edit"],
        ["employees.view", "admin.users.manage"],
      ] as const) {
        const actor = await actorWith(database(), scenario, granted);

        await expect(
          linkUser(database(), actor, {
            employeeId: id,
            userId: user.id,
            expectedVersion: 1,
          }),
        ).rejects.toBeInstanceOf(AuthorizationError);
      }
    });

    it("transfers no permissions either way", async () => {
      const user = await createServerUser();
      const before = await getUserAuthContext(database(), user.id);
      const { id } = await createEmployeeFixture(database(), scenario.owner, {
        positionId: scenario.bartender,
      });

      await linkUser(database(), scenario.owner, {
        employeeId: id,
        userId: user.id,
        expectedVersion: 1,
      });

      expect(await getUserAuthContext(database(), user.id)).toEqual(before);
    });

    it("unlinks with permission, and the user keeps their access", async () => {
      const { user, employeeId } = await createLinkedEmployee();
      const before = await getUserAuthContext(database(), user.id);

      await unlinkUser(database(), scenario.owner, {
        employeeId,
        expectedVersion: 2,
      });

      expect(
        await getLinkedUser(database(), scenario.owner, employeeId),
      ).toBeNull();
      expect(await getUserAuthContext(database(), user.id)).toEqual(before);
    });

    it("rejects unlinking when nothing is linked", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await expect(
        unlinkUser(database(), scenario.owner, {
          employeeId: id,
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("hides the linked user without admin.users.view", async () => {
      const { employeeId } = await createLinkedEmployee();
      const viewer = await actorWith(database(), scenario, ["employees.view"]);

      await expect(
        getLinkedUser(database(), viewer, employeeId),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });
  });

  describe("termination", () => {
    it("sets the status and date, ends eligibility, appends history and keeps the record", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner, {
        positionId: scenario.server,
      });

      await terminate(scenario.owner, id, 1);

      const [employee] = await database()
        .select()
        .from(employees)
        .where(eq(employees.id, id));
      const locations = await database()
        .select()
        .from(employeeLocations)
        .where(eq(employeeLocations.employeeId, id));
      const positions = await database()
        .select()
        .from(employeePositions)
        .where(eq(employeePositions.employeeId, id));
      const history = await database()
        .select()
        .from(employeeStatusHistory)
        .where(eq(employeeStatusHistory.employeeId, id));

      expect(employee).toMatchObject({
        employmentStatus: "TERMINATED",
        terminationDate: "2024-06-30",
        primaryLocationId: null,
      });
      expect(locations).toHaveLength(1);
      expect(locations[0]).toMatchObject({
        active: false,
        primaryLocation: false,
        effectiveTo: "2024-06-30",
      });
      expect(positions[0]).toMatchObject({
        active: false,
        primaryPosition: false,
        effectiveTo: "2024-06-30",
      });
      expect(history.map((row) => row.status).sort()).toEqual([
        "ACTIVE",
        "TERMINATED",
      ]);
    });

    it("closes a future-dated assignment on its own start date", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await assignLocation(database(), scenario.owner, scenario.ownerAtB, {
        employeeId: id,
        effectiveFrom: "2030-01-01",
        expectedVersion: 1,
      });
      await terminate(scenario.owner, id);

      const rows = await database()
        .select()
        .from(employeeLocations)
        .where(eq(employeeLocations.locationId, scenario.locationB));

      expect(rows.find((row) => row.employeeId === id)).toMatchObject({
        active: false,
        effectiveFrom: "2030-01-01",
        effectiveTo: "2030-01-01",
      });
    });

    it("keeps a terminated employee reachable, not treated as active", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await terminate(scenario.owner, id, 1);

      const employment = await getEmployeeEmployment(
        database(),
        scenario.owner,
        id,
      );

      expect(employment.employmentStatus).toBe("TERMINATED");
      expect(employment.terminationDate).toBe("2024-06-30");
    });

    it("disables the linked user in the same transaction, ending their access", async () => {
      const { user, employeeId } = await createLinkedEmployee();

      expect(await getUserAuthContext(database(), user.id)).not.toBeNull();

      await terminate(scenario.owner, employeeId);

      const row = await findUserRow(database(), user.id);

      expect(row.active).toBe(false);
      expect(row.disabledAt).not.toBeNull();
      expect(await getUserAuthContext(database(), user.id)).toBeNull();
    });

    it("rejects a second termination", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await terminate(scenario.owner, id, 1);

      await expect(terminate(scenario.owner, id, 2)).rejects.toMatchObject({
        code: "EMPLOYEE_TERMINATED",
      });
    });

    it.each([
      ["before hire", "2020-01-01", "TERMINATION_BEFORE_HIRE"],
      ["in the future", "2099-01-01", "TERMINATION_IN_FUTURE"],
    ])("rejects a date %s and rolls back", async (_label, date, code) => {
      const { user, employeeId } = await createLinkedEmployee();

      await expect(
        terminate(scenario.owner, employeeId, 2, date),
      ).rejects.toMatchObject({ code });

      expect((await findUserRow(database(), user.id)).active).toBe(true);
    });

    it("rejects a stale version and changes nothing", async () => {
      const { user, employeeId } = await createLinkedEmployee();

      await expect(
        terminate(scenario.owner, employeeId, 99),
      ).rejects.toBeInstanceOf(ConcurrencyError);
      expect((await findUserRow(database(), user.id)).active).toBe(true);
    });

    it("needs employees.terminate, not admin.users.manage", async () => {
      const { user, employeeId } = await createLinkedEmployee();
      const editor = await actorWith(database(), scenario, [
        "employees.edit",
        "employees.view",
        "admin.users.manage",
      ]);
      // Holds the Server role's permissions too, so no-escalation doesn't apply.
      const terminator = await actorWith(database(), scenario, [
        "employees.terminate",
        "orders.create",
      ]);

      await expect(terminate(editor, employeeId)).rejects.toBeInstanceOf(
        AuthorizationError,
      );

      await terminate(terminator, employeeId);

      expect((await findUserRow(database(), user.id)).active).toBe(false);
    });
  });

  describe("termination against the Phase 2 safeguards", () => {
    const stateOf = async (employeeId: string) => {
      const [row] = await database()
        .select({ status: employees.employmentStatus })
        .from(employees)
        .where(eq(employees.id, employeeId));
      const locations = await database()
        .select({ active: employeeLocations.active })
        .from(employeeLocations)
        .where(eq(employeeLocations.employeeId, employeeId));
      const history = await database()
        .select({ id: employeeStatusHistory.id })
        .from(employeeStatusHistory)
        .where(eq(employeeStatusHistory.employeeId, employeeId));

      return {
        status: row?.status,
        anyActiveLocation: locations.some((location) => location.active),
        historyRows: history.length,
      };
    };

    const untouched = {
      status: "ACTIVE",
      anyActiveLocation: true,
      historyRows: 1,
    };

    it("rejects terminating your own employee record, changing nothing", async () => {
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await linkUser(database(), scenario.owner, {
        employeeId: id,
        userId: scenario.owner.userId,
        expectedVersion: 1,
      });

      await expect(terminate(scenario.owner, id)).rejects.toMatchObject({
        code: "SELF_TERMINATION_NOT_ALLOWED",
      });
      expect(await stateOf(id)).toEqual(untouched);
      expect((await findUserRow(database(), scenario.owner.userId)).active).toBe(
        true,
      );
    });

    it("rejects terminating someone who holds permissions you lack, changing nothing", async () => {
      const privileged = await createUserFixture(database(), {
        assignments: [
          { roleId: scenario.ownerRole, locationId: scenario.locationA },
        ],
      });
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await linkUser(database(), scenario.owner, {
        employeeId: id,
        userId: privileged.id,
        expectedVersion: 1,
      });

      const terminator = await actorWith(database(), scenario, [
        "employees.terminate",
      ]);

      await expect(terminate(terminator, id)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      expect(await stateOf(id)).toEqual(untouched);
      expect((await findUserRow(database(), privileged.id)).active).toBe(true);
    });

    it("rejects terminating the organization's last Owner, changing nothing", async () => {
      // A separate organization, so its Owner count is exactly known.
      const organization = await createOrganizationFixture(database());
      const lastOwner = await createUserFixture(database(), {
        assignments: [
          { roleId: organization.ownerRole, locationId: organization.locationA },
        ],
      });
      const ownerActor = await actorAt(
        database(),
        lastOwner.id,
        organization.locationA,
      );
      const { id } = await createEmployeeFixture(database(), ownerActor);

      await linkUser(database(), ownerActor, {
        employeeId: id,
        userId: lastOwner.id,
        expectedVersion: 1,
      });

      // Holds every permission, so only the last-Owner rule can refuse this.
      const everyPermissionRole = await createRoleFixture(
        database(),
        organization.organizationId,
        ["employees.terminate", "menu.view"],
      );
      const terminatorUser = await createUserFixture(database(), {
        assignments: [
          { roleId: everyPermissionRole, locationId: organization.locationA },
        ],
      });
      const terminator = {
        ...(await actorAt(database(), terminatorUser.id, organization.locationA)),
        permissions: new Set(ownerActor.permissions),
      };

      await expect(terminate(terminator, id)).rejects.toMatchObject({
        code: "LAST_OWNER",
      });
      expect(await stateOf(id)).toEqual(untouched);
      expect((await findUserRow(database(), lastOwner.id)).active).toBe(true);
    });

    it("allows it when another Owner remains", async () => {
      const organization = await createOrganizationFixture(database());
      const [first, second] = await Promise.all(
        [0, 1].map(() =>
          createUserFixture(database(), {
            assignments: [
              {
                roleId: organization.ownerRole,
                locationId: organization.locationA,
              },
            ],
          }),
        ),
      );
      const firstActor = await actorAt(
        database(),
        first!.id,
        organization.locationA,
      );
      const { id } = await createEmployeeFixture(database(), firstActor);

      await linkUser(database(), firstActor, {
        employeeId: id,
        userId: second!.id,
        expectedVersion: 1,
      });

      await terminate(firstActor, id);

      expect((await findUserRow(database(), second!.id)).active).toBe(false);
    });
  });

  describe("no path back to access", () => {
    it("rejects re-enabling the linked user of a terminated employee", async () => {
      const { user, employeeId } = await createLinkedEmployee();

      await terminate(scenario.owner, employeeId);

      const { version } = await findUserRow(database(), user.id);

      await expect(
        setUserActive(database(), scenario.owner, {
          userId: user.id,
          active: true,
          expectedVersion: version,
        }),
      ).rejects.toMatchObject({ code: "USER_LINKED_TO_TERMINATED_EMPLOYEE" });
      expect(await getUserAuthContext(database(), user.id)).toBeNull();
    });

    it("allows it only after a deliberate unlink", async () => {
      const { user, employeeId } = await createLinkedEmployee();

      await terminate(scenario.owner, employeeId);
      await unlinkUser(database(), scenario.owner, {
        employeeId,
        expectedVersion: 3,
      });

      const { version } = await findUserRow(database(), user.id);

      await setUserActive(database(), scenario.owner, {
        userId: user.id,
        active: true,
        expectedVersion: version,
      });

      expect(await getUserAuthContext(database(), user.id)).not.toBeNull();
    });

    it("won't link a user to an already-terminated employee", async () => {
      const user = await createServerUser();
      const { id } = await createEmployeeFixture(database(), scenario.owner);

      await terminate(scenario.owner, id, 1);

      await expect(
        linkUser(database(), scenario.owner, {
          employeeId: id,
          userId: user.id,
          expectedVersion: 2,
        }),
      ).rejects.toMatchObject({ code: "EMPLOYEE_TERMINATED" });
    });

    it("still enables a user whose employee is active or absent", async () => {
      const { user } = await createLinkedEmployee();
      const unlinked = await createServerUser();

      for (const target of [user, unlinked]) {
        const disabled = await setUserActive(database(), scenario.owner, {
          userId: target.id,
          active: false,
          expectedVersion: target.version,
        });

        await expect(
          setUserActive(database(), scenario.owner, {
            userId: target.id,
            active: true,
            expectedVersion: disabled.version,
          }),
        ).resolves.toMatchObject({ active: true });
      }
    });
  });
});
