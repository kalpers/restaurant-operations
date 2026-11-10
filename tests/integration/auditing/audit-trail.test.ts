import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, employees, orders } from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import { listAuditEvents, recordAudit } from "@/modules/auditing";
import { createRole } from "@/modules/auth/services/role-service";
import { verifyCredentials } from "@/modules/auth/services/credential-service";
import type { Actor } from "@/modules/auth/types";
import { changeCompensation, getCompensationHistory } from "@/modules/employees/services/compensation-service";
import { getEmployeePersonal, updatePersonalContact } from "@/modules/employees/services/personal-service";
import { exportReportCsv } from "@/modules/reporting/services/report-service";
import { AppError } from "@/shared/errors/app-error";
import { runWithRequestContext } from "@/shared/http/request-context";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";
import { voidOrderItem } from "@/workflows/void-order-item/void-order-item";

import { createUserFixture } from "../../fixtures/auth-fixtures";
import { actorWith, clearEmployeeData, createEmployeeFixture } from "../../fixtures/employee-fixtures";
import { createKitchenScenario, sendOrder, type KitchenScenario } from "../../fixtures/kitchen-fixtures";
import { clearOrderData, itemRows, newKey } from "../../fixtures/order-fixtures";
import { opened, SERVER_SETTLEMENT_PERMISSIONS, settlementRow, tender } from "../../fixtures/settlement-fixtures";

const database = () => getDatabase();

function eventsFor(entityId: string) {
  return database()
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.entityId, entityId))
    .orderBy(asc(auditEvents.sequence));
}

function eventsOf(action: string, entityId: string) {
  return database()
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.entityId, entityId)))
    .orderBy(asc(auditEvents.sequence));
}

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return error instanceof AppError ? error.code : (error as { cause?: { code?: string } }).cause?.code;
  }

  return undefined;
}

describe("audit trail", () => {
  let scenario: KitchenScenario;
  let auditor: Actor;
  let today: string;

  beforeAll(async () => {
    scenario = await createKitchenScenario(database());
    auditor = await actorWith(database(), scenario, ["audit.view", "reports.view", "reports.sales", "reports.export"]);
  });

  afterAll(async () => {
    await clearOrderData(database());
    await clearEmployeeData(database());
    await closeDatabase();
  });

  describe("the table", () => {
    it("is append-only: UPDATE, DELETE and TRUNCATE are refused", async () => {
      await withTransaction(database(), (transaction) =>
        recordAudit(transaction, auditor, { action: "reports.exported", entityId: null, details: { area: "probe" } }),
      );

      expect(await codeOf(database().execute(sql`UPDATE audit_events SET action = 'x.y'`))).toBe("23514");
      expect(await codeOf(database().execute(sql`DELETE FROM audit_events`))).toBe("23514");
      expect(await codeOf(database().execute(sql`TRUNCATE audit_events`))).toBe("23514");
    });

    it("writes nothing when the action's transaction rolls back", async () => {
      const marker = crypto.randomUUID();

      await expect(
        withTransaction(database(), async (transaction) => {
          await recordAudit(transaction, auditor, { action: "menu.item-updated", entityId: marker });
          throw new Error("roll back");
        }),
      ).rejects.toThrow("roll back");

      expect(await eventsFor(marker)).toEqual([]);
    });

    it("records the request ID and the acting user's employee, and drops unlisted fields", async () => {
      const marker = crypto.randomUUID();
      const linked = await createEmployeeFixture(database(), scenario.owner);

      await database().update(employees).set({ userId: auditor.userId }).where(eq(employees.id, linked!.id));
      await runWithRequestContext({ requestId: "req-audit-1" }, () =>
        withTransaction(database(), (transaction) =>
          recordAudit(transaction, auditor, {
            action: "menu.item-updated",
            entityId: marker,
            after: { name: "Burger", passwordHash: "secret", nested: { a: 1 } },
          }),
        ),
      );
      await database().update(employees).set({ userId: null }).where(eq(employees.id, linked!.id));

      const [event] = await eventsFor(marker);

      expect(event).toMatchObject({
        actorType: "USER",
        actorUserId: auditor.userId,
        actorEmployeeId: linked!.id,
        organizationId: scenario.organizationId,
        locationId: scenario.locationA,
        category: "MENU",
        entityType: "menu_item",
        requestId: "req-audit-1",
        after: { name: "Burger" },
      });
    });
  });

  describe("access", () => {
    it("records a successful sign-in, and a failed one for a known account with its reason", async () => {
      const user = await createUserFixture(database(), {
        assignments: [{ roleId: scenario.ownerRole, locationId: scenario.locationA }],
      });

      expect(await verifyCredentials(database(), user)).toEqual({ id: user.id });
      expect(await verifyCredentials(database(), { email: user.email, password: "wrong-password-123" })).toBeNull();

      const events = await eventsFor(user.id);

      expect(events.map((event) => [event.action, event.details])).toEqual([
        ["auth.signed-in", null],
        ["auth.sign-in-failed", { reason: "BAD_PASSWORD" }],
      ]);
      expect(events.every((event) => event.locationId === null && event.organizationId === scenario.organizationId)).toBe(true);
      expect(JSON.stringify(events)).not.toContain(user.email);
      expect(JSON.stringify(events)).not.toContain(user.password);
    });

    it("records DISABLED for a disabled account, and nothing for an unknown email", async () => {
      const disabled = await createUserFixture(database(), {
        active: false,
        assignments: [{ roleId: scenario.ownerRole, locationId: scenario.locationA }],
      });
      const [{ count: before }] = (await database().execute(sql`SELECT count(*)::int AS count FROM audit_events`)) as unknown as [
        { count: number },
      ];

      expect(await verifyCredentials(database(), disabled)).toBeNull();
      expect(await verifyCredentials(database(), { email: "nobody@example.test", password: "whatever-123" })).toBeNull();

      const [{ count: after }] = (await database().execute(sql`SELECT count(*)::int AS count FROM audit_events`)) as unknown as [
        { count: number },
      ];

      expect(after - before).toBe(1);
      expect((await eventsFor(disabled.id)).map((event) => event.details)).toEqual([{ reason: "DISABLED" }]);
    });

    it("defers a failed sign-in's audit write until after the answer, when the route asks", async () => {
      const user = await createUserFixture(database(), {
        assignments: [{ roleId: scenario.ownerRole, locationId: scenario.locationA }],
      });
      const deferred: (() => Promise<void>)[] = [];

      expect(
        await verifyCredentials(
          database(),
          { email: user.email, password: "wrong-password-123" },
          { deferFailureAudit: (task) => deferred.push(task) },
        ),
      ).toBeNull();
      // Answered with nothing written: the same work as an unknown email.
      expect(await eventsFor(user.id)).toEqual([]);
      expect(deferred).toHaveLength(1);

      await deferred[0]!();

      expect((await eventsFor(user.id)).map((event) => event.details)).toEqual([{ reason: "BAD_PASSWORD" }]);
    });

    it("records role creation as an organization-level security event", async () => {
      const role = await createRole(database(), scenario.owner, {
        code: `AUDIT_${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        name: "Audit fixture",
        description: null,
      });
      const [event] = await eventsOf("admin.role-created", role.id);

      expect(event).toMatchObject({ category: "SECURITY", locationId: null, actorUserId: scenario.owner.userId });
    });
  });

  describe("orders and settlements", () => {
    it("records one SEND event, and none for a retry with the same key", async () => {
      const burger = scenario.burger;
      const { order, key } = await sendOrder(database(), scenario, [
        { menuItemId: burger.menuItem.id, selections: burger.canonicalSelections },
      ]);
      const [row] = await database().select().from(orders).where(eq(orders.id, order.id));

      today = row!.businessDate;

      const retry = await sendOrderItems(database(), scenario.serverActor, order.id, {
        expectedVersion: row!.version - 1,
        idempotencyKey: key,
      });
      const events = await eventsOf("orders.items-sent", order.id);

      expect(retry.replayed).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ category: "ORDERS", after: { itemCount: 1, batchNumber: 1 } });
    });

    it("records a void with its disposition and reason", async () => {
      const { order } = await sendOrder(database(), scenario, [{ menuItemId: scenario.fries.id }], { orderType: "TAKEOUT" });
      const [item] = await itemRows(database(), order.id);
      const [row] = await database().select().from(orders).where(eq(orders.id, order.id));

      await voidOrderItem(database(), scenario.voidManager, order.id, item!.id, {
        reason: "Wrong item",
        disposition: "UNPREPARED",
        expectedVersion: row!.version,
      });

      const [event] = await eventsOf("orders.item-voided", order.id);

      expect(event?.after).toMatchObject({ orderItemId: item!.id, status: "VOIDED", disposition: "UNPREPARED", reason: "Wrong item" });
    });

    it("records settlement steps, never the card details on a tender", async () => {
      const cashier = await actorWith(database(), scenario, SERVER_SETTLEMENT_PERMISSIONS);
      const { order } = await sendOrder(database(), scenario, [{ menuItemId: scenario.cocktail.id }], { orderType: "TAKEOUT" });
      const settlement = await opened(database(), cashier, order.id);

      await tender(database(), cashier, settlement.settlementId, {
        tenderType: "EXTERNAL_CARD",
        amount: "11.00",
        tipAmount: "2.00",
        providerName: "Square",
        cardBrand: "Visa",
        cardLastFour: "4242",
        authorizationReference: "AUTH-998877",
      });
      await completeSettlement(database(), cashier, settlement.settlementId, {
        expectedVersion: (await settlementRow(database(), settlement.settlementId)).version,
        idempotencyKey: newKey(),
      });

      const events = await eventsFor(settlement.settlementId);
      const text = JSON.stringify(events);

      expect(events.map((event) => event.action)).toEqual([
        "settlements.opened",
        "settlements.tender-recorded",
        "settlements.completed",
      ]);
      expect(events[1]?.after).toMatchObject({ tenderType: "EXTERNAL_CARD", amount: "11.00", tipAmount: "2.00" });
      expect(text).not.toContain("4242");
      expect(text).not.toContain("AUTH-998877");
      expect(text).not.toContain("Visa");
    });

    it("records a CSV export with its range and row count", async () => {
      const exported = await exportReportCsv(database(), auditor, "sales", {
        locationId: scenario.locationA,
        from: today,
        to: today,
      });
      const [event] = await database()
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "reports.exported"), eq(auditEvents.actorUserId, auditor.userId)))
        .orderBy(sql`${auditEvents.sequence} DESC`)
        .limit(1);

      expect(exported.csv.length).toBeGreaterThan(0);
      expect(event?.details).toMatchObject({ area: "sales", from: today, to: today });
      expect(typeof (event?.details as { rowCount: number }).rowCount).toBe("number");
    });
  });

  describe("set-up through the domain services", () => {
    it("left one audit event per menu, recipe and inventory action it took", async () => {
      const rows = await database()
        .selectDistinct({ action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.organizationId, scenario.organizationId));
      const actions = rows.map((row) => row.action);

      for (const expected of ["menu.item-created", "menu.price-changed", "recipes.revision-created", "recipes.revision-published"]) {
        expect(actions, expected).toContain(expected);
      }
    });
  });

  describe("HR", () => {
    it("records a wage change and a wage view without any amount", async () => {
      const position = scenario.server;
      const employee = await createEmployeeFixture(database(), scenario.owner, { positionId: position });

      await changeCompensation(database(), scenario.owner, {
        employeeId: employee.id,
        positionId: position,
        compensationType: "HOURLY",
        hourlyRate: "23.75",
        annualSalary: null,
        effectiveFrom: "2024-02-01",
        changeReason: "Raise",
      });
      await getCompensationHistory(database(), scenario.owner, employee.id);

      const events = await eventsFor(employee.id);
      const changed = events.find((event) => event.action === "hr.compensation-changed");

      expect(changed?.after).toMatchObject({ payType: "HOURLY", rate: true, effectiveFrom: "2024-02-01" });
      expect(events.map((event) => event.action)).toContain("hr.compensation-viewed");
      expect(JSON.stringify(events)).not.toContain("23.75");
    });

    it("records personal-data changes by field name only, and personal-data views", async () => {
      const employee = await createEmployeeFixture(database(), scenario.owner);

      await updatePersonalContact(database(), scenario.owner, employee.id, {
        personalEmail: null,
        phone: "555-0142",
        expectedVersion: employee.version,
      });
      await getEmployeePersonal(database(), scenario.owner, employee.id);

      const events = await eventsFor(employee.id);
      const updated = events.find((event) => event.action === "hr.personal-updated");

      expect(updated?.details).toMatchObject({ kind: "CONTACT", changedFields: ["phone"] });
      expect(events.map((event) => event.action)).toContain("hr.personal-viewed");
      expect(JSON.stringify(events)).not.toContain("555-0142");
    });
  });

  describe("the viewer", () => {
    const range = () => ({ locationId: scenario.locationA, from: today, to: today });

    it("needs audit.view at the location asked for", async () => {
      const noAudit = await actorWith(database(), scenario, ["reports.view"]);

      expect(await codeOf(listAuditEvents(database(), noAudit, range()))).toBe("PERMISSION_DENIED");
      expect(await codeOf(listAuditEvents(database(), auditor, { ...range(), locationId: scenario.locationB }))).toBe(
        "PERMISSION_DENIED",
      );
    });

    it("shows the location's events and organization-level ones, newest first", async () => {
      const page = await listAuditEvents(database(), auditor, range());
      const actions = page.events.map((event) => event.action);
      const sequences = page.events.map((event) => event.sequence);

      expect(actions).toContain("orders.items-sent");
      expect(actions).toContain("admin.role-created");
      expect(sequences).toEqual([...sequences].sort((a, b) => b - a));
      expect(page.events.every((event) => event.locationId === scenario.locationA || event.locationId === null)).toBe(true);
    });

    it("hides another location's events", async () => {
      const auditorAtB = await actorWith(database(), scenario, ["audit.view"], scenario.locationB);
      const page = await listAuditEvents(database(), auditorAtB, { ...range(), locationId: scenario.locationB });

      expect(page.events.some((event) => event.locationId === scenario.locationA)).toBe(false);
    });

    it("pages with a cursor", async () => {
      await withTransaction(database(), (transaction) =>
        recordAudit(
          transaction,
          auditor,
          Array.from({ length: 105 }, () => ({ action: "menu.item-updated" as const, entityId: null })),
        ),
      );

      const first = await listAuditEvents(database(), auditor, { ...range(), action: "menu.item-updated" });
      const second = await listAuditEvents(database(), auditor, {
        ...range(),
        action: "menu.item-updated",
        before: first.nextBefore!,
      });

      expect(first.events).toHaveLength(100);
      expect(first.nextBefore).not.toBeNull();
      expect(second.events.length).toBeGreaterThanOrEqual(5);
      expect(Math.max(...second.events.map((event) => event.sequence))).toBeLessThan(first.nextBefore!);
    });

    it("refuses a range longer than 92 days", async () => {
      expect(await codeOf(listAuditEvents(database(), auditor, { ...range(), from: "2026-01-01", to: "2026-06-01" }))).toBe(
        "VALIDATION_FAILED",
      );
    });
  });
});
