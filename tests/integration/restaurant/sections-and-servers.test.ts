import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  employees,
  serverSectionAssignments,
  serverSectionTables,
  userRoles,
} from "@/db/schema";
import { getFloorStatus, listServerCandidates } from "@/modules/restaurant/services/floor-service";
import {
  assignServerToSection,
  createSection,
  endSectionAssignment,
  listSections,
  setSectionTables,
  updateSection,
} from "@/modules/restaurant/services/section-service";
import { assignSessionServer } from "@/modules/restaurant/services/session-service";
import { changeEmployeeStatus } from "@/modules/employees/services/status-service";
import { AuthorizationError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";
import { businessDateOf } from "@/shared/time/business-date-service";
import { seatParty } from "@/workflows/seat-party/seat-party";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import { saveCompensationForTest } from "../../fixtures/compensation-probe";
import {
  createRestaurantScenario,
  hostActor,
  putOnShift,
  serverFixture,
  sessionOverrides,
  sessionRow,
  tableFixture,
  type RestaurantScenario,
} from "../../fixtures/restaurant-fixtures";

const database = () => getDatabase();

describe("server sections and qualification", () => {
  let scenario: RestaurantScenario;
  let codeCounter = 0;

  beforeEach(async () => {
    scenario = await createRestaurantScenario(database());
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  const sectionFixture = (areaId: string | null = scenario.dining) =>
    createSection(database(), scenario.owner, {
      code: `S${(codeCounter += 1)}`,
      name: "Section",
      restaurantAreaId: areaId,
    });

  async function sectionWithTables(tableIds: string[], areaId?: string) {
    const section = await sectionFixture(areaId ?? scenario.dining);

    return setSectionTables(database(), scenario.owner, section.id, {
      tableIds,
      expectedVersion: section.version,
    });
  }

  describe("configuration", () => {
    it("creates a section and refuses a duplicate code at one location", async () => {
      await createSection(database(), scenario.owner, {
        code: "DINING_A",
        name: "A",
        restaurantAreaId: scenario.dining,
      });

      await expect(
        createSection(database(), scenario.owner, {
          code: "DINING_A",
          name: "B",
          restaurantAreaId: scenario.dining,
        }),
      ).rejects.toMatchObject({ code: "SECTION_CODE_TAKEN" });
    });

    it("refuses Takeout and an area at another location", async () => {
      await expect(sectionFixture(scenario.takeout)).rejects.toMatchObject({
        code: "TAKEOUT_HAS_NO_TABLES",
      });
      await expect(sectionFixture(scenario.diningAtB)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("assigns tables, with a stale edit refused", async () => {
      const table = await tableFixture(database(), scenario);
      const section = await sectionFixture();
      const update = { tableIds: [table], expectedVersion: section.version };

      await setSectionTables(database(), scenario.owner, section.id, update);

      await expect(
        setSectionTables(database(), scenario.owner, section.id, update),
      ).rejects.toBeInstanceOf(ConcurrencyError);
      expect(
        (await listSections(database(), scenario.owner))[0]?.tables.map(
          (row) => row.tableId,
        ),
      ).toEqual([table]);
    });

    it("refuses a table at another location", async () => {
      const elsewhere = await tableFixture(
        database(),
        { ...scenario, owner: scenario.ownerAtB },
        { areaId: scenario.diningAtB },
      );
      const section = await sectionFixture();

      await expect(
        setSectionTables(database(), scenario.owner, section.id, {
          tableIds: [elsewhere],
          expectedVersion: section.version,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses a cross-location membership in PostgreSQL", async () => {
      const elsewhere = await tableFixture(
        database(),
        { ...scenario, owner: scenario.ownerAtB },
        { areaId: scenario.diningAtB },
      );
      const section = await sectionFixture();

      await expect(
        database().insert(serverSectionTables).values({
          serverSectionId: section.id,
          locationId: scenario.locationA,
          restaurantTableId: elsewhere,
        }),
      ).rejects.toThrow();
    });

    it("refuses a table outside the section's area", async () => {
      const bar = await tableFixture(database(), scenario, { areaId: scenario.bar });
      const section = await sectionFixture();

      await expect(
        setSectionTables(database(), scenario.owner, section.id, {
          tableIds: [bar],
          expectedVersion: section.version,
        }),
      ).rejects.toMatchObject({ code: "TABLE_SECTION_AREA_MISMATCH" });
    });

    it("lets a table be in only one active section, and frees it when removed", async () => {
      const table = await tableFixture(database(), scenario);
      const first = await sectionWithTables([table]);
      const second = await sectionFixture();

      await expect(
        setSectionTables(database(), scenario.owner, second.id, {
          tableIds: [table],
          expectedVersion: second.version,
        }),
      ).rejects.toMatchObject({ code: "TABLE_IN_ANOTHER_SECTION" });

      await setSectionTables(database(), scenario.owner, first.id, {
        tableIds: [],
        expectedVersion: first.version,
      });
      await expect(
        setSectionTables(database(), scenario.owner, second.id, {
          tableIds: [table],
          expectedVersion: second.version,
        }),
      ).resolves.toBeDefined();

      // The old membership stays as history.
      expect(
        await database()
          .select()
          .from(serverSectionTables)
          .where(eq(serverSectionTables.restaurantTableId, table)),
      ).toHaveLength(2);
    });

    it("refuses a second active membership in PostgreSQL", async () => {
      const table = await tableFixture(database(), scenario);

      await sectionWithTables([table]);

      const second = await sectionFixture();

      await expect(
        database().insert(serverSectionTables).values({
          serverSectionId: second.id,
          locationId: scenario.locationA,
          restaurantTableId: table,
        }),
      ).rejects.toThrow();
    });

    it("deactivates only after its server has ended, and releases its tables", async () => {
      const table = await tableFixture(database(), scenario);
      const section = await sectionWithTables([table]);
      const server = await serverFixture(database(), scenario);

      await putOnShift(database(), scenario, server, scenario.server);

      const assignment = await assignServerToSection(
        database(),
        scenario.owner,
        section.id,
        { employeeId: server },
      );
      const input = {
        name: "Section",
        restaurantAreaId: scenario.dining,
        active: false,
        expectedVersion: section.version,
      };

      await expect(
        updateSection(database(), scenario.owner, section.id, input),
      ).rejects.toMatchObject({ code: "SECTION_HAS_SERVER" });

      await endSectionAssignment(database(), scenario.owner, assignment.id, {
        expectedVersion: assignment.version,
      });
      await updateSection(database(), scenario.owner, section.id, input);

      const other = await sectionFixture();

      await expect(
        setSectionTables(database(), scenario.owner, other.id, {
          tableIds: [table],
          expectedVersion: other.version,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe("assigning a server to a section", () => {
    it("assigns a qualified, scheduled server for today's business date", async () => {
      const section = await sectionFixture();
      const server = await serverFixture(database(), scenario);

      await putOnShift(database(), scenario, server, scenario.server);

      const host = await hostActor(database(), scenario);
      const before = new Date();
      const assignment = await assignServerToSection(database(), host, section.id, {
        employeeId: server,
      });
      const [row] = await database()
        .select()
        .from(serverSectionAssignments)
        .where(eq(serverSectionAssignments.id, assignment.id));

      expect(row).toMatchObject({
        employeeId: server,
        assignedByUserId: host.userId,
        effectiveTo: null,
        scheduleOverrideReason: null,
      });
      expect(row!.businessDate).toBe(
        businessDateOf(before, {
          timeZone: "America/Detroit",
          businessDayCutoff: "04:00:00",
        }),
      );
    });

    it("grants no permissions and changes no roles", async () => {
      const section = await sectionFixture();
      const linked = await actorWith(database(), scenario, ["menu.view"]);
      const server = await serverFixture(database(), scenario);

      await database()
        .update(employees)
        .set({ userId: linked.userId })
        .where(eq(employees.id, server));

      const rolesBefore = await database()
        .select()
        .from(userRoles)
        .where(eq(userRoles.userId, linked.userId));

      await assignServerToSection(database(), scenario.owner, section.id, {
        employeeId: server,
        scheduleOverrideReason: "Fixture",
      });

      expect(
        await database()
          .select()
          .from(userRoles)
          .where(eq(userRoles.userId, linked.userId)),
      ).toEqual(rolesBefore);
    });

    it("refuses a second server until the first is ended", async () => {
      const section = await sectionFixture();
      const first = await serverFixture(database(), scenario);
      const second = await serverFixture(database(), scenario);
      const assignment = await assignServerToSection(
        database(),
        scenario.owner,
        section.id,
        { employeeId: first, scheduleOverrideReason: "Fixture" },
      );

      await expect(
        assignServerToSection(database(), scenario.owner, section.id, {
          employeeId: second,
          scheduleOverrideReason: "Fixture",
        }),
      ).rejects.toMatchObject({ code: "SECTION_ALREADY_ASSIGNED" });

      await endSectionAssignment(database(), scenario.owner, assignment.id, {
        expectedVersion: assignment.version,
      });
      await expect(
        assignServerToSection(database(), scenario.owner, section.id, {
          employeeId: second,
          scheduleOverrideReason: "Fixture",
        }),
      ).resolves.toBeDefined();
    });

    it("refuses an inactive section", async () => {
      const section = await sectionFixture();
      const server = await serverFixture(database(), scenario);

      await updateSection(database(), scenario.owner, section.id, {
        name: "Section",
        restaurantAreaId: scenario.dining,
        active: false,
        expectedVersion: section.version,
      });

      await expect(
        assignServerToSection(database(), scenario.owner, section.id, {
          employeeId: server,
          scheduleOverrideReason: "Fixture",
        }),
      ).rejects.toMatchObject({ code: "SECTION_INACTIVE" });
    });

    it("uses the tables' areas when the section has none", async () => {
      const bar = await tableFixture(database(), scenario, { areaId: scenario.bar });
      const section = await sectionFixture(null);
      const updated = await setSectionTables(database(), scenario.owner, section.id, {
        tableIds: [bar],
        expectedVersion: section.version,
      });
      const bartender = await serverFixture(database(), scenario, scenario.bartender);

      expect(updated.version).toBe(section.version + 1);
      await expect(
        assignServerToSection(database(), scenario.owner, section.id, {
          employeeId: bartender,
          scheduleOverrideReason: "Fixture",
        }),
      ).resolves.toBeDefined();
    });

    it("refuses a section with no area and no tables", async () => {
      const section = await sectionFixture(null);

      await expect(
        assignServerToSection(database(), scenario.owner, section.id, {
          employeeId: await serverFixture(database(), scenario),
          scheduleOverrideReason: "Fixture",
        }),
      ).rejects.toMatchObject({ code: "SECTION_HAS_NO_AREA" });
    });

    it("refuses stale and repeated ends", async () => {
      const section = await sectionFixture();
      const assignment = await assignServerToSection(
        database(),
        scenario.owner,
        section.id,
        {
          employeeId: await serverFixture(database(), scenario),
          scheduleOverrideReason: "Fixture",
        },
      );

      await expect(
        endSectionAssignment(database(), scenario.owner, assignment.id, {
          expectedVersion: assignment.version + 1,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);

      await endSectionAssignment(database(), scenario.owner, assignment.id, {
        expectedVersion: assignment.version,
      });

      await expect(
        endSectionAssignment(database(), scenario.owner, assignment.id, {
          expectedVersion: assignment.version + 1,
        }),
      ).rejects.toMatchObject({ code: "ASSIGNMENT_ALREADY_ENDED" });
    });
  });

  describe("HR qualification", () => {
    async function assignToDining(employeeId: string) {
      const section = await sectionFixture();

      return assignServerToSection(database(), scenario.owner, section.id, {
        employeeId,
        scheduleOverrideReason: "Fixture override",
      });
    }

    it("doesn't accept a security role: a role named Server without the position fails", async () => {
      const noPosition = await serverFixture(database(), scenario, null);
      const linked = await actorWith(database(), scenario, ["orders.create"]);

      await database()
        .update(employees)
        .set({ userId: linked.userId })
        .where(eq(employees.id, noPosition));

      await expect(assignToDining(noPosition)).rejects.toMatchObject({
        code: "SERVER_NOT_QUALIFIED",
      });
    });

    it("accepts the position with no login or role at all", async () => {
      await expect(
        assignToDining(await serverFixture(database(), scenario)),
      ).resolves.toBeDefined();
    });

    it("accepts WAIT_STAFF in the dining room", async () => {
      await expect(
        assignToDining(await serverFixture(database(), scenario, scenario.waitStaff)),
      ).resolves.toBeDefined();
    });

    it("refuses BARTENDER in the dining room, and accepts them at the bar", async () => {
      const bartender = await serverFixture(database(), scenario, scenario.bartender);

      await expect(assignToDining(bartender)).rejects.toMatchObject({
        code: "SERVER_NOT_QUALIFIED",
      });

      const barSection = await sectionFixture(scenario.bar);

      await expect(
        assignServerToSection(database(), scenario.owner, barSection.id, {
          employeeId: bartender,
          scheduleOverrideReason: "Fixture",
        }),
      ).resolves.toBeDefined();
    });

    it("refuses HOST and COOK", async () => {
      await expect(
        assignToDining(await serverFixture(database(), scenario, scenario.hostPosition)),
      ).rejects.toMatchObject({ code: "SERVER_NOT_QUALIFIED" });
      await expect(
        assignToDining(await serverFixture(database(), scenario, scenario.cook)),
      ).rejects.toMatchObject({ code: "SERVER_NOT_QUALIFIED" });
    });

    it("refuses an employee who isn't ACTIVE, even with an override and a shift", async () => {
      const server = await serverFixture(database(), scenario);
      const [row] = await database()
        .select({ version: employees.version })
        .from(employees)
        .where(eq(employees.id, server));

      await putOnShift(database(), scenario, server, scenario.server);
      await changeEmployeeStatus(database(), scenario.owner, {
        employeeId: server,
        status: "ON_LEAVE",
        reason: null,
        expectedVersion: row!.version,
      });

      await expect(assignToDining(server)).rejects.toMatchObject({
        code: "SERVER_NOT_QUALIFIED",
      });
    });

    it("refuses someone with no assignment at this location", async () => {
      const server = await serverFixture(database(), scenario);
      const section = await createSection(database(), scenario.ownerAtB, {
        code: "AT_B",
        name: "At B",
        restaurantAreaId: scenario.diningAtB,
      });

      await expect(
        assignServerToSection(database(), scenario.ownerAtB, section.id, {
          employeeId: server,
          scheduleOverrideReason: "Fixture",
        }),
      ).rejects.toMatchObject({ code: "SERVER_NOT_QUALIFIED" });
    });
  });

  describe("the published schedule", () => {
    async function assignAsHost(server: string, overrideReason?: string) {
      const host = await hostActor(database(), scenario);
      const section = await sectionFixture();

      return assignServerToSection(database(), host, section.id, {
        employeeId: server,
        scheduleOverrideReason: overrideReason ?? null,
      });
    }

    it.each([
      ["no published schedule at all", null],
      ["a draft period", { periodStatus: "DRAFT" }],
      ["an archived period", { periodStatus: "ARCHIVED" }],
      ["a shift that hasn't started", { startsInMinutes: 30, endsInMinutes: 90 }],
      ["a shift that has ended", { startsInMinutes: -90, endsInMinutes: -30 }],
      ["an ended assignment", { assignmentEnded: true }],
      ["a cancelled shift", { cancelled: true }],
    ] as const)("doesn't count %s", async (_label, shift) => {
      const server = await serverFixture(database(), scenario);

      if (shift) {
        await putOnShift(database(), scenario, server, scenario.server, shift);
      }

      await expect(assignAsHost(server)).rejects.toMatchObject({
        code: "SERVER_NOT_SCHEDULED",
      });
    });

    it("counts a shift running right now", async () => {
      const server = await serverFixture(database(), scenario);

      await putOnShift(database(), scenario, server, scenario.server);

      await expect(assignAsHost(server)).resolves.toBeDefined();
    });

    it("doesn't count a shift at another location", async () => {
      const server = await serverFixture(database(), scenario);

      await putOnShift(database(), scenario, server, scenario.server, {
        locationId: scenario.locationB,
      });

      await expect(assignAsHost(server)).rejects.toMatchObject({
        code: "SERVER_NOT_SCHEDULED",
      });
    });

    it("doesn't count a shift in a position that doesn't suit the area", async () => {
      // Qualified for dining through SERVER, but working a Cook shift.
      const server = await serverFixture(database(), scenario);

      await putOnShift(database(), scenario, server, scenario.cook);

      await expect(assignAsHost(server)).rejects.toMatchObject({
        code: "SERVER_NOT_SCHEDULED",
      });
    });

    it("refuses a host who sends an override reason", async () => {
      await expect(
        assignAsHost(await serverFixture(database(), scenario), "Please"),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("requires a reason with the override permission, and stores it", async () => {
      const manager = await actorWith(database(), scenario, [
        "restaurant.view",
        "restaurant.server.assign",
        "restaurant.schedule.override",
      ]);
      const section = await sectionFixture();
      const server = await serverFixture(database(), scenario);

      await expect(
        assignServerToSection(database(), manager, section.id, {
          employeeId: server,
        }),
      ).rejects.toMatchObject({ code: "SCHEDULE_OVERRIDE_REASON_REQUIRED" });

      const assignment = await assignServerToSection(database(), manager, section.id, {
        employeeId: server,
        scheduleOverrideReason: "Sick call",
      });
      const [row] = await database()
        .select()
        .from(serverSectionAssignments)
        .where(eq(serverSectionAssignments.id, assignment.id));

      expect(row?.scheduleOverrideReason).toBe("Sick call");
    });
  });

  describe("sections and sessions", () => {
    async function sectionServedBy(tableIds: string[], onShift = true) {
      const section = await sectionWithTables(tableIds);
      const server = await serverFixture(database(), scenario);

      if (onShift) {
        await putOnShift(database(), scenario, server, scenario.server);
      }

      const assignment = await assignServerToSection(
        database(),
        scenario.owner,
        section.id,
        {
          employeeId: server,
          scheduleOverrideReason: onShift ? null : "Fixture",
        },
      );

      return { section, server, assignment };
    }

    it("defaults a new session to the section's server", async () => {
      const table = await tableFixture(database(), scenario);
      const { server } = await sectionServedBy([table]);
      const session = await seatParty(database(), scenario.owner, {
        tableIds: [table],
        partySize: 2,
      });

      expect(session).toMatchObject({
        assignedServerEmployeeId: server,
        warnings: [],
      });
    });

    it("doesn't default when the party is seated explicitly with no server", async () => {
      const table = await tableFixture(database(), scenario);

      await sectionServedBy([table]);

      const session = await seatParty(database(), scenario.owner, {
        tableIds: [table],
        partySize: 2,
        serverEmployeeId: null,
      });

      expect(session.assignedServerEmployeeId).toBeNull();
    });

    it("doesn't apply a default that would need an override, and warns", async () => {
      const table = await tableFixture(database(), scenario);

      await sectionServedBy([table], false);

      const session = await seatParty(database(), scenario.owner, {
        tableIds: [table],
        partySize: 2,
      });

      expect(session).toMatchObject({
        assignedServerEmployeeId: null,
        warnings: ["SECTION_SERVER_NOT_APPLIED"],
      });
      expect(await sessionOverrides(database(), session.id)).toEqual([]);
    });

    it("doesn't default when tables have different section servers", async () => {
      const a = await tableFixture(database(), scenario);
      const b = await tableFixture(database(), scenario);

      await sectionServedBy([a]);
      await sectionServedBy([b]);

      const session = await seatParty(database(), scenario.owner, {
        tableIds: [a, b],
        partySize: 2,
      });

      expect(session).toMatchObject({
        assignedServerEmployeeId: null,
        warnings: ["SECTION_SERVER_NOT_APPLIED"],
      });
    });

    it("doesn't default when only some tables have a section server", async () => {
      const a = await tableFixture(database(), scenario);
      const b = await tableFixture(database(), scenario);

      await sectionServedBy([a]);

      expect(
        await seatParty(database(), scenario.owner, {
          tableIds: [a, b],
          partySize: 2,
        }),
      ).toMatchObject({ assignedServerEmployeeId: null });
    });

    it("reassigns a session without touching the section", async () => {
      const table = await tableFixture(database(), scenario);
      const { server, section } = await sectionServedBy([table]);
      const session = await seatParty(database(), scenario.owner, {
        tableIds: [table],
        partySize: 2,
      });
      const other = await serverFixture(database(), scenario);

      await putOnShift(database(), scenario, other, scenario.server);
      await assignSessionServer(database(), scenario.owner, session.id, {
        serverEmployeeId: other,
        expectedVersion: session.version,
      });

      const listed = await listSections(database(), scenario.owner);

      expect(
        listed.find((row) => row.id === section.id)?.currentAssignment?.employeeId,
      ).toBe(server);
    });

    it("doesn't rewrite an active session's server when the section changes", async () => {
      const table = await tableFixture(database(), scenario);
      const { server, assignment, section } = await sectionServedBy([table]);
      const session = await seatParty(database(), scenario.owner, {
        tableIds: [table],
        partySize: 2,
      });

      await endSectionAssignment(database(), scenario.owner, assignment.id, {
        expectedVersion: assignment.version,
      });
      await setSectionTables(database(), scenario.owner, section.id, {
        tableIds: [],
        expectedVersion: section.version,
      });

      expect(
        (await sessionRow(database(), session.id)).assignedServerEmployeeId,
      ).toBe(server);
    });
  });

  describe("safe floor data", () => {
    it("lists candidates by exact safe keys, without status or restricted HR", async () => {
      const server = await serverFixture(database(), scenario);

      await saveCompensationForTest(database(), scenario, server, "98765.43");
      await putOnShift(database(), scenario, server, scenario.server);

      const host = await hostActor(database(), scenario);
      const candidates = await listServerCandidates(database(), host, {
        areaId: scenario.dining,
      });

      expect(candidates).toHaveLength(1);
      expect(Object.keys(candidates[0]!).sort()).toEqual([
        "displayName",
        "employeeId",
        "scheduledNow",
      ]);
      expect(candidates[0]).toMatchObject({ employeeId: server, scheduledNow: true });
      expect(JSON.stringify(candidates)).not.toContain("98765");
    });

    it("omits people who don't qualify for the area", async () => {
      await serverFixture(database(), scenario, scenario.bartender);
      await serverFixture(database(), scenario, scenario.cook);

      expect(
        await listServerCandidates(database(), scenario.owner, {
          areaId: scenario.dining,
        }),
      ).toEqual([]);
      expect(
        await listServerCandidates(database(), scenario.owner, {
          areaId: scenario.bar,
        }),
      ).toHaveLength(1);
    });

    it("shows the floor with no restricted HR data, and exact keys", async () => {
      const table = await tableFixture(database(), scenario);
      const server = await serverFixture(database(), scenario);

      await saveCompensationForTest(database(), scenario, server, "98765.43");
      await seatParty(database(), scenario.owner, {
        tableIds: [table],
        partySize: 2,
        serverEmployeeId: server,
        scheduleOverrideReason: "Fixture",
      });

      const floor = await getFloorStatus(
        database(),
        await hostActor(database(), scenario),
      );
      const row = floor.find((entry) => entry.id === table)!;

      expect(Object.keys(row).sort()).toEqual([
        "area",
        "availability",
        "capacity",
        "condition",
        "id",
        "minimumCapacity",
        "name",
        "section",
        "session",
        "tableNumber",
        "version",
        "warnings",
      ]);
      expect(Object.keys(row.session!).sort()).toEqual([
        "id",
        "partySize",
        "seatedAt",
        "serverEmployeeId",
        "serverName",
        "tables",
        "version",
      ]);
      expect(row.session?.serverName).toBe("Jane Smith");

      const text = JSON.stringify(floor);

      for (const hidden of ["98765", "employmentStatus", "ON_LEAVE", "ACTIVE", "workEmail"]) {
        expect(text).not.toContain(hidden);
      }
    });

    it("flags a server who has stopped qualifying, without unseating anyone", async () => {
      const table = await tableFixture(database(), scenario);
      const server = await serverFixture(database(), scenario);
      const session = await seatParty(database(), scenario.owner, {
        tableIds: [table],
        partySize: 2,
        serverEmployeeId: server,
        scheduleOverrideReason: "Fixture",
      });
      const [row] = await database()
        .select({ version: employees.version })
        .from(employees)
        .where(eq(employees.id, server));

      await changeEmployeeStatus(database(), scenario.owner, {
        employeeId: server,
        status: "SUSPENDED",
        reason: null,
        expectedVersion: row!.version,
      });

      const floor = await getFloorStatus(database(), scenario.owner);

      expect(floor.find((entry) => entry.id === table)?.warnings).toEqual([
        "SERVER_NEEDS_REASSIGNMENT",
      ]);
      expect((await sessionRow(database(), session.id)).status).toBe("ACTIVE");
    });
  });
});
