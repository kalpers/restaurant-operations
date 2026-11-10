import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents } from "@/db/schema";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import { listAuditEvents } from "@/modules/auditing/queries/audit-queries";
import { getCompensationHistory } from "@/modules/employees/services/compensation-service";
import { getEmployeePersonal } from "@/modules/employees/services/personal-service";
import { transitionTicketItem } from "@/modules/kitchen/services/fulfillment-service";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { buildDashboard, exportReportCsv, runReport } from "@/modules/reporting/services/report-service";
import { REPORT_AREA_PERMISSION, REPORT_AREAS } from "@/modules/reporting/types";
import { getOrderSettlementView } from "@/modules/settlements/queries/settlement-queries";
import { openSettlement, voidTender, type RecordTenderInput } from "@/modules/settlements/services/settlement-service";
import type { AppError } from "@/shared/errors/app-error";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import { newKey } from "../../fixtures/order-fixtures";
import {
  DAY,
  FRIDAY,
  REPORTER_PERMISSIONS,
  runRestaurantDay,
  startFakeClock,
  stopFakeClock,
  type RestaurantDay,
} from "../../fixtures/restaurant-day";
import { tender } from "../../fixtures/settlement-fixtures";

const database = () => getDatabase();

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as AppError).code;
  }

  return "OK";
}

const ALL_REPORT_CODES: readonly PermissionCode[] = [
  "reports.view",
  ...new Set(Object.values(REPORT_AREA_PERMISSION)),
];

const TENDER_PERMISSION: Record<RecordTenderInput["tenderType"], PermissionCode> = {
  CASH: "settlements.tender.cash",
  EXTERNAL_CARD: "settlements.tender.external-card",
  GIFT_CARD: "settlements.tender.gift-card",
  HOUSE_ACCOUNT: "settlements.tender.house-account",
  OTHER: "settlements.tender.other",
};

/**
 * Phase 13's security pass over the simulated day's real data, in one place: report RBAC,
 * export, HR and wage boundaries, settlement permissions, card metadata and location
 * isolation. Every refusal is checked at the service, which each route calls; signed-out
 * and forged-session refusals at the HTTP boundary are covered by the Playwright suites.
 */
describe("Phase 13: security validation", () => {
  let day: RestaurantDay;
  let filters: { locationId: string; from: string; to: string };
  const make = (granted: readonly PermissionCode[], locationId?: string) =>
    actorWith(database(), day.scenario, granted, locationId);

  beforeAll(async () => {
    startFakeClock();

    try {
      day = await runRestaurantDay(database());
    } finally {
      stopFakeClock();
    }

    filters = { locationId: day.scenario.locationA, from: DAY, to: DAY };
  }, 120_000);

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  describe("reporting RBAC", () => {
    it.each(REPORT_AREAS)("refuses the %s report without its area permission or reports.view", async (area) => {
      const withoutArea = await make(ALL_REPORT_CODES.filter((code) => code !== REPORT_AREA_PERMISSION[area]));
      const withoutView = await make(ALL_REPORT_CODES.filter((code) => code !== "reports.view"));
      const allowed = await make([...ALL_REPORT_CODES]);

      expect(await codeOf(runReport(database(), withoutArea, area, filters))).toBe("PERMISSION_DENIED");
      expect(await codeOf(runReport(database(), withoutView, area, filters))).toBe("PERMISSION_DENIED");
      expect(await codeOf(runReport(database(), allowed, area, filters))).toBe("OK");
    });

    it("export needs reports.export, and only an allowed export is audited", async () => {
      const exportCount = async () =>
        (
          await database()
            .select()
            .from(auditEvents)
            .where(and(eq(auditEvents.action, "reports.exported"), eq(auditEvents.locationId, day.scenario.locationA)))
        ).length;
      const noExport = await make(ALL_REPORT_CODES.filter((code) => code !== "reports.export"));
      const before = await exportCount();

      expect(await codeOf(exportReportCsv(database(), noExport, "sales", filters))).toBe("PERMISSION_DENIED");
      expect(await exportCount()).toBe(before);

      const { csv } = await exportReportCsv(database(), day.actors.reporter, "sales", filters);

      expect(csv).toContain("53.48");
      expect(await exportCount()).toBe(before + 1);
    });

    it("labor without hr.compensation.view shows hours and no cost, in reports, export and dashboard", async () => {
      const hoursOnly = await make(REPORTER_PERMISSIONS.filter((code) => code !== "hr.compensation.view"));
      const labor = await runReport(database(), hoursOnly, "labor", filters);
      const { csv } = await exportReportCsv(database(), hoursOnly, "labor", filters);
      const dashboard = await buildDashboard(database(), hoursOnly, day.scenario.locationA, DAY);
      const text = JSON.stringify(labor) + csv + JSON.stringify(dashboard);

      expect(labor.sections.find((section) => section.key === "summary")!.rows[0]).toMatchObject({ hours: "25.0000" });

      for (const section of labor.sections) {
        expect(section.columns.map((column) => column.key), section.key).not.toContain("cost");
      }

      // No figure that would reveal a wage: the total, each shift's cost, or a rate.
      for (const figure of ["362.00", "120.00", "98.00", "144.00", "12.00", "14.00", "18.00"]) {
        expect(text, figure).not.toContain(figure);
      }
    });

    it("cost columns need inventory.cost.view", async () => {
      const noCost = await make(REPORTER_PERMISSIONS.filter((code) => code !== "inventory.cost.view"));

      for (const area of ["menu", "inventory"] as const) {
        const report = await runReport(database(), noCost, area, filters);

        for (const section of report.sections) {
          expect(
            section.columns.filter((column) => /cost/i.test(column.key)).map((column) => column.key),
            `${area}/${section.key}`,
          ).toEqual([]);
        }
      }
    });
  });

  describe("settlement permissions", () => {
    let settlementId: string;

    beforeAll(async () => {
      const server = day.actors.server;
      const order = await createOrder(database(), server, { orderType: "TAKEOUT", customerName: null });
      const drafted = await addDraftItem(database(), server, order.id, {
        expectedVersion: order.version,
        menuItemId: day.scenario.fries.id,
        quantity: 1,
        selections: [],
        specialInstructions: null,
      });

      await sendOrderItems(database(), server, order.id, { expectedVersion: drafted.orderVersion, idempotencyKey: newKey() });
      settlementId = (await openSettlement(database(), server, order.id)).settlementId;
    });

    it.each(Object.entries(TENDER_PERMISSION))("a %s tender needs %s", async (tenderType, permission) => {
      const others = Object.values(TENDER_PERMISSION).filter((code) => code !== permission);
      const actor = await make(["orders.view", "settlements.view", "settlements.create", ...others]);
      const values = {
        tenderType: tenderType as RecordTenderInput["tenderType"],
        amount: "1.00",
        otherDescription: tenderType === "OTHER" ? "Voucher" : null,
      };

      expect(await codeOf(tender(database(), actor, settlementId, values))).toBe("PERMISSION_DENIED");
    });

    it("voiding a tender needs settlements.void-tender", async () => {
      const recorded = await tender(database(), day.actors.server, settlementId, {
        tenderType: "CASH",
        amount: "1.00",
        receivedAmount: "1.00",
      });

      expect(
        await codeOf(
          voidTender(database(), day.actors.server, settlementId, recorded.tenderId, {
            expectedVersion: recorded.settlementVersion,
            reason: "Wrong tender",
          }),
        ),
      ).toBe("PERMISSION_DENIED");
    });

    it("card references appear only with settlements.view-card-metadata", async () => {
      const plain = JSON.stringify(await getOrderSettlementView(database(), day.actors.server, day.orders.garcia.id));
      const withMetadata = await make(["orders.view", "settlements.view", "settlements.view-card-metadata"]);
      const detailed = JSON.stringify(await getOrderSettlementView(database(), withMetadata, day.orders.garcia.id));

      expect(plain).not.toContain("4242");
      expect(plain).not.toContain("Square");
      expect(detailed).toContain("4242");
    });
  });

  describe("location isolation", () => {
    let elsewhere: Actor;

    beforeAll(() => {
      // The owner holds every permission, but this actor is resolved at location B.
      elsewhere = day.scenario.ownerAtB;
    });

    it("another location's orders, settlements and kitchen work look absent", async () => {
      const ticket = (await database().query.kitchenTicketItems.findFirst({
        where: (items, { eq: equals }) => equals(items.orderId, day.orders.garcia.id),
      }))!;

      expect(await codeOf(getOrderSettlementView(database(), elsewhere, day.orders.garcia.id))).toBe("NOT_FOUND");
      expect(
        await codeOf(sendOrderItems(database(), elsewhere, day.orders.garcia.id, { expectedVersion: 1, idempotencyKey: newKey() })),
      ).toBe("NOT_FOUND");
      expect(
        await codeOf(transitionTicketItem(database(), elsewhere, ticket.id, "start", { expectedVersion: ticket.version })),
      ).toBe("NOT_FOUND");
    });

    it("another location's reports and audit trail are refused", async () => {
      expect(await codeOf(runReport(database(), elsewhere, "sales", filters))).toBe("PERMISSION_DENIED");
      expect(await codeOf(exportReportCsv(database(), elsewhere, "sales", filters))).toBe("PERMISSION_DENIED");
      expect(
        await codeOf(listAuditEvents(database(), elsewhere, { locationId: day.scenario.locationA, from: FRIDAY, to: DAY })),
      ).toBe("PERMISSION_DENIED");

      // At its own location B the same owner sees none of the day.
      const atB = await runReport(database(), elsewhere, "sales", { ...filters, locationId: day.scenario.locationB });

      expect(atB.sections.find((section) => section.key === "summary")!.rows[0]).toMatchObject({ closedOrders: 0 });
    });
  });

  describe("HR boundaries", () => {
    it("the management tier reads neither wages nor personal data", async () => {
      const management = await make(["employees.view", "hr.view", "hr.notes.view", "hr.performance.view", "schedule.view"]);

      expect(await codeOf(getCompensationHistory(database(), management, day.employees.server))).toBe("PERMISSION_DENIED");
      expect(await codeOf(getEmployeePersonal(database(), management, day.employees.server))).toBe("PERMISSION_DENIED");
    });

    it("a restricted read is allowed with its permission, and is itself audited", async () => {
      const payroll = await make(["employees.view", "hr.compensation.view"]);
      const history = await getCompensationHistory(database(), payroll, day.employees.server);
      const [event] = await database()
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "hr.compensation-viewed"), eq(auditEvents.actorUserId, payroll.userId)));

      expect(JSON.stringify(history)).toContain("12.00");
      expect(event).toBeDefined();
      expect(JSON.stringify(event)).not.toContain("12.00");
    });
  });
});
