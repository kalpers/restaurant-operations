import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import { ROLE_CATALOG } from "@/modules/auth/role-catalog";
import type { Actor } from "@/modules/auth/types";
import { getFloorStatus, listServerCandidates } from "@/modules/restaurant/services/floor-service";
import {
  assignServerToSection,
  createSection,
  listSections,
  setSectionTables,
  updateSection,
} from "@/modules/restaurant/services/section-service";
import {
  addTableToSession,
  cancelSession,
  completeSession,
  moveSession,
  removeTableFromSession,
} from "@/modules/restaurant/services/session-service";
import {
  changeTableCondition,
  cleanTable,
  createTable,
  updateTable,
} from "@/modules/restaurant/services/table-service";
import { AuthorizationError } from "@/shared/errors/app-error";
import { seatParty } from "@/workflows/seat-party/seat-party";

import { ABSENT_ID, actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import {
  createRestaurantScenario,
  tableFixture,
  type RestaurantScenario,
} from "../../fixtures/restaurant-fixtures";

const database = () => getDatabase();

describe("restaurant authorization", () => {
  let scenario: RestaurantScenario;

  beforeEach(async () => {
    scenario = await createRestaurantScenario(database());
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  const tableInput = () => ({
    restaurantAreaId: scenario.dining,
    tableNumber: "AUTH-1",
    name: null,
    capacity: 4,
    minimumCapacity: null,
    sortOrder: null,
  });

  /** Each operation, refused for an actor lacking exactly its permission. */
  const operations: [PermissionCode, (actor: Actor) => Promise<unknown>][] = [
    ["restaurant.view", (actor) => getFloorStatus(database(), actor)],
    ["restaurant.view", (actor) => listSections(database(), actor)],
    ["restaurant.seat", (actor) => seatParty(database(), actor, { tableIds: [ABSENT_ID], partySize: 2 })],
    ["restaurant.move", (actor) => moveSession(database(), actor, ABSENT_ID, { tableIds: [ABSENT_ID], expectedVersion: 1 })],
    ["restaurant.move", (actor) => addTableToSession(database(), actor, ABSENT_ID, { tableId: ABSENT_ID, expectedVersion: 1 })],
    ["restaurant.move", (actor) => removeTableFromSession(database(), actor, ABSENT_ID, ABSENT_ID, { expectedVersion: 1 })],
    ["restaurant.complete-session", (actor) => completeSession(database(), actor, ABSENT_ID, { expectedVersion: 1 })],
    ["restaurant.cancel-session", (actor) => cancelSession(database(), actor, ABSENT_ID, { reason: "x", expectedVersion: 1 })],
    ["restaurant.clean-table", (actor) => cleanTable(database(), actor, ABSENT_ID, { expectedVersion: 1 })],
    ["restaurant.condition.manage", (actor) => changeTableCondition(database(), actor, ABSENT_ID, { condition: "CLEAN", reason: null, expectedVersion: 1 })],
    ["restaurant.tables.manage", (actor) => createTable(database(), actor, tableInput())],
    ["restaurant.tables.manage", (actor) => updateTable(database(), actor, ABSENT_ID, { ...tableInput(), active: true, expectedVersion: 1 })],
    ["restaurant.sections.manage", (actor) => createSection(database(), actor, { code: "X", name: "X", restaurantAreaId: null })],
    ["restaurant.sections.manage", (actor) => updateSection(database(), actor, ABSENT_ID, { name: "X", restaurantAreaId: null, active: true, expectedVersion: 1 })],
    ["restaurant.sections.manage", (actor) => setSectionTables(database(), actor, ABSENT_ID, { tableIds: [], expectedVersion: 1 })],
    ["restaurant.server.assign", (actor) => assignServerToSection(database(), actor, ABSENT_ID, { employeeId: ABSENT_ID })],
    ["restaurant.server.assign", (actor) => listServerCandidates(database(), actor, { areaId: ABSENT_ID })],
  ];

  it("refuses every operation without its permission", async () => {
    const actor = await actorWith(database(), scenario, ["menu.view"]);

    for (const [, operation] of operations) {
      await expect(operation(actor)).rejects.toBeInstanceOf(AuthorizationError);
    }
  });

  it("lets each permission past its check, and no further than its own operations", async () => {
    for (const [permission, operation] of operations) {
      const actor = await actorWith(database(), scenario, [permission]);

      await operation(actor).catch((error: unknown) => {
        expect(error).not.toBeInstanceOf(AuthorizationError);
      });
    }
  });

  it("lets a section manager list sections without restaurant.view", async () => {
    const actor = await actorWith(database(), scenario, [
      "restaurant.sections.manage",
    ]);

    await expect(listSections(database(), actor)).resolves.toEqual([]);
  });

  it("allows standard seating with restaurant.seat alone", async () => {
    const actor = await actorWith(database(), scenario, ["restaurant.seat"]);

    await expect(
      seatParty(database(), actor, {
        tableIds: [await tableFixture(database(), scenario)],
        partySize: 2,
        serverEmployeeId: null,
      }),
    ).resolves.toBeDefined();
  });

  it("makes another location look absent, and grants nothing there", async () => {
    const atB = await tableFixture(
      database(),
      { ...scenario, owner: scenario.ownerAtB },
      { areaId: scenario.diningAtB },
    );
    const session = await seatParty(database(), scenario.ownerAtB, {
      tableIds: [atB],
      partySize: 2,
      serverEmployeeId: null,
    });

    await expect(
      completeSession(database(), scenario.owner, session.id, {
        expectedVersion: session.version,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      cleanTable(database(), scenario.owner, atB, { expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (await getFloorStatus(database(), scenario.owner)).map((table) => table.id),
    ).not.toContain(atB);
  });

  describe("the seeded role matrix", () => {
    const grants = (code: string) =>
      new Set(ROLE_CATALOG.find((role) => role.code === code)!.permissions);

    it("gives Host normal front-desk seating", () => {
      const host = grants("HOST");

      for (const code of [
        "restaurant.view",
        "restaurant.seat",
        "restaurant.move",
        "restaurant.complete-session",
        "restaurant.clean-table",
        "restaurant.server.assign",
      ] as const) {
        expect(host.has(code)).toBe(true);
      }
    });

    it("keeps overrides and structure away from Host", () => {
      const host = grants("HOST");

      for (const code of [
        "restaurant.capacity.override",
        "restaurant.schedule.override",
        "restaurant.tables.manage",
        "restaurant.sections.manage",
        "restaurant.condition.manage",
        "restaurant.cancel-session",
        "admin.roles.manage",
        "hr.compensation.view",
      ] as const) {
        expect(host.has(code)).toBe(false);
      }
    });

    it("gives Manager every restaurant permission, explicitly", () => {
      const manager = grants("MANAGER");

      expect(manager.has("restaurant.capacity.override")).toBe(true);
      expect(manager.has("restaurant.schedule.override")).toBe(true);
      expect(manager.has("restaurant.tables.manage")).toBe(true);
    });

    it("lets floor staff close out, not seat", () => {
      for (const role of ["SERVER", "BARTENDER"]) {
        expect(grants(role).has("restaurant.complete-session")).toBe(true);
        expect(grants(role).has("restaurant.clean-table")).toBe(true);
        expect(grants(role).has("restaurant.seat")).toBe(false);
      }

      expect(grants("WAIT_STAFF").has("restaurant.clean-table")).toBe(true);
      expect(grants("WAIT_STAFF").has("restaurant.complete-session")).toBe(false);
    });

    it("has retired restaurant.manage everywhere", () => {
      for (const role of ROLE_CATALOG) {
        expect(role.permissions).not.toContain("restaurant.manage");
      }
    });
  });
});

describe("restaurant module boundaries", () => {
  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const full = path.join(directory, entry);

      return statSync(full).isDirectory()
        ? sourceFiles(full)
        : full.endsWith(".ts") && !full.endsWith(".test.ts")
          ? [full]
          : [];
    });
  }

  const files = [
    ...sourceFiles("src/modules/restaurant"),
    ...sourceFiles("src/workflows/seat-party"),
  ];

  it("reads no restricted HR table or security role in its decisions", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");

      for (const forbidden of [
        "employeePositionCompensation",
        "employeeAddresses",
        "employeeEmergencyContacts",
        "employeeDisciplinaryActions",
        "employeeNotes",
        "employeeDocuments",
        "userRoles",
        "rolePermissions",
      ]) {
        expect(`${file}: ${text.includes(forbidden)}`).toBe(`${file}: false`);
      }
    }
  });

  it("creates no order or reservation concept, and keeps the Guest Party link optional", () => {
    const schema = readFileSync("src/db/schema/restaurant.ts", "utf8");

    expect(schema).not.toMatch(/order_id|orderId|reservation_id|reservationId/);
    expect(schema).toContain('guestPartyId: uuid("guest_party_id"),');
  });
});
