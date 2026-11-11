import { sql } from "drizzle-orm";

import type { Database } from "@/db";
import { withReadOnlySnapshot, withTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import { AuthorizationError, NotFoundError } from "@/shared/errors/app-error";
import { addDecimals } from "@/shared/decimal/decimal";
import { businessDateOf } from "@/shared/time/business-date-service";

import { fulfillmentSections } from "../queries/fulfillment-report";
import { inventorySections } from "../queries/inventory-report";
import { laborSections } from "../queries/labor-report";
import { menuSections } from "../queries/menu-report";
import { orderSections } from "../queries/order-report";
import { loadLocationClock, loadReportContext, type ReportContext } from "../queries/report-context";
import { salesSections } from "../queries/sales-report";
import { seatingSections } from "../queries/seating-report";
import { settlementSections } from "../queries/settlement-report";
import {
  adjustmentsByEmployeeSection,
  eightySixHistorySection,
  itemMixSections,
  salesByHourSection,
  serverPerformanceSection,
} from "../queries/signals-report";
import { tipsSections } from "../queries/tips-report";
import { csvFileName, reportToCsv } from "../rules/csv";
import { assertValidRange } from "../rules/period";
import {
  REPORT_AREA_PERMISSION,
  REPORT_AREA_TITLE,
  type ReportArea,
  type ReportCell,
  type ReportFilters,
  type ReportResult,
  type ReportSection,
} from "../types";

// Phase 19 sections follow each area's existing ones, which stay exactly as they were.
const BUILDERS: Record<ReportArea, (context: ReportContext) => Promise<ReportSection[]>> = {
  sales: async (context) => [...(await salesSections(context)), await salesByHourSection(context)],
  menu: async (context) => [...(await menuSections(context)), ...(await itemMixSections(context))],
  settlements: settlementSections,
  orders: async (context) => [
    ...(await orderSections(context)),
    await serverPerformanceSection(context),
    await adjustmentsByEmployeeSection(context),
  ],
  inventory: async (context) => [...(await inventorySections(context)), await eightySixHistorySection(context)],
  fulfillment: fulfillmentSections,
  labor: laborSections,
  seating: seatingSections,
  tips: tipsSections,
};

function holds(actor: Actor, permission: PermissionCode): boolean {
  return actor.permissions.has(permission);
}

/**
 * Every report checks for itself, however the request arrives: the actor must be resolved
 * at the requested Location and hold `reports.view` plus the area's permission there.
 */
export function assertReportAccess(actor: Actor, area: ReportArea, locationId: string): void {
  if (
    actor.locationId !== locationId ||
    !holds(actor, "reports.view") ||
    !holds(actor, REPORT_AREA_PERMISSION[area])
  ) {
    throw new AuthorizationError();
  }
}

/** Areas the actor may open at their location, in display order. */
export function permittedAreas(actor: Actor): ReportArea[] {
  if (!holds(actor, "reports.view")) {
    return [];
  }

  return (Object.keys(BUILDERS) as ReportArea[]).filter((area) => holds(actor, REPORT_AREA_PERMISSION[area]));
}

function notesFor(area: ReportArea, context: ReportContext): string[] {
  const notes: string[] = [];

  if (["menu", "inventory"].includes(area) && !context.canViewCost) {
    notes.push("Cost columns are hidden: they need the inventory cost permission.");
  }

  if (area === "labor") {
    notes.push(
      "Scheduled labor is from published schedules. Actual labor is from closed time entries; open entries count zero until closed.",
    );

    if (!context.canViewCompensation) {
      notes.push("Labor cost and labor % are hidden: they need the compensation-view permission.");
    }
  }

  if (["sales", "menu", "orders"].includes(area)) {
    notes.push("Net sales are CLOSED orders before tax; tax is shown separately. Refunds count on the day they were given.");
  }

  if (area === "orders" && !context.canViewTips) {
    notes.push("Tips by server are hidden: they need the Tips report or tip-pool permission.");
  }

  return notes;
}

/**
 * Builds one report inside a READ ONLY, REPEATABLE READ transaction: it cannot write, and
 * every figure comes from the same snapshot. Reporting never changes any record.
 */
export async function runReport(
  database: Database,
  actor: Actor,
  area: ReportArea,
  filters: ReportFilters,
): Promise<ReportResult> {
  assertReportAccess(actor, area, filters.locationId);
  assertValidRange(filters.from, filters.to);

  return withReadOnlySnapshot(database, async (tx) => {
    const context = await loadReportContext(tx, actor, filters);

    return {
      area,
      title: REPORT_AREA_TITLE[area],
      location: context.location,
      filters,
      notes: notesFor(area, context),
      sections: await BUILDERS[area](context),
    };
  });
}

/** CSV export needs `reports.export` as well as the area's own permissions. */
export async function exportReportCsv(
  database: Database,
  actor: Actor,
  area: ReportArea,
  filters: ReportFilters,
  sectionKey?: string,
): Promise<{ fileName: string; csv: string }> {
  assertReportAccess(actor, area, filters.locationId);

  if (!holds(actor, "reports.export")) {
    throw new AuthorizationError();
  }

  const report = await runReport(database, actor, area, filters);
  const sections = sectionKey
    ? report.sections.filter((section) => section.key === sectionKey)
    : report.sections;

  if (sections.length === 0) {
    throw new NotFoundError("That report section does not exist.");
  }

  const csv = reportToCsv(report, sections);

  // The report ran READ ONLY; recording the export is a separate, short write. If it can't
  // be recorded, the export is refused.
  await withTransaction(database, (transaction) =>
    recordAudit(transaction, actor, {
      action: "reports.exported",
      entityId: null,
      details: {
        area: sectionKey ? `${area}:${sectionKey}` : area,
        from: filters.from,
        to: filters.to,
        rowCount: sections.reduce((total, section) => total + section.rows.length, 0),
      },
    }),
  );

  return { fileName: csvFileName(report, sectionKey), csv };
}

export type DashboardTile = { key: string; label: string; value: ReportCell; kind: "money" | "count" | "minutes" | "percent" | "hours" | "cost" };

export type DashboardGroup = { area: ReportArea; title: string; tiles: DashboardTile[] };

export type Dashboard = {
  location: { id: string; code: string; name: string };
  businessDate: string;
  groups: DashboardGroup[];
};

function rowWhere(section: ReportSection | undefined, key: string, value: ReportCell) {
  return section?.rows.find((row) => row[key] === value);
}

function sectionOf(sections: ReportSection[], key: string) {
  return sections.find((section) => section.key === key);
}

/** The operational overview: headline figures for one business date, per permitted area. */
export async function buildDashboard(
  database: Database,
  actor: Actor,
  locationId: string,
  businessDate?: string,
): Promise<Dashboard> {
  if (actor.locationId !== locationId || !holds(actor, "reports.view")) {
    throw new AuthorizationError();
  }

  const areas = permittedAreas(actor).filter((area) => area !== "menu");

  return withReadOnlySnapshot(database, async (tx) => {
    const { settings } = await loadLocationClock(tx, locationId);
    const date = businessDate ?? businessDateOf(new Date(), settings);

    assertValidRange(date, date);

    const context = await loadReportContext(tx, actor, { locationId, from: date, to: date });
    const groups: DashboardGroup[] = [];

    for (const area of areas) {
      const sections = await BUILDERS[area](context);

      groups.push({ area, title: REPORT_AREA_TITLE[area], tiles: tilesFor(area, sections, context) });
    }

    return { location: context.location, businessDate: date, groups };
  });
}

function tilesFor(area: ReportArea, sections: ReportSection[], context: ReportContext): DashboardTile[] {
  switch (area) {
    case "sales": {
      const all = rowWhere(sectionOf(sections, "summary"), "orderType", "All");

      return [
        { key: "netSales", label: "Net sales", value: all?.netSales ?? "0.00", kind: "money" },
        { key: "closedOrders", label: "Closed orders", value: all?.closedOrders ?? 0, kind: "count" },
        { key: "averageCheck", label: "Average check", value: all?.averageCheck ?? null, kind: "money" },
        { key: "openChecks", label: "Open checks", value: all?.openChecks ?? 0, kind: "count" },
        { key: "openAmount", label: "Open check amount", value: all?.openAmount ?? "0.00", kind: "money" },
      ];
    }
    case "settlements": {
      const all = rowWhere(sectionOf(sections, "tenders"), "tenderType", "All");

      return [
        { key: "tendered", label: "Tendered", value: all?.amount ?? "0.00", kind: "money" },
        { key: "tips", label: "Tips", value: all?.tips ?? "0.00", kind: "money" },
        { key: "tenders", label: "Tenders", value: all?.tenders ?? 0, kind: "count" },
      ];
    }
    case "orders": {
      const all = rowWhere(sectionOf(sections, "lifecycle"), "orderType", "All");

      return [
        { key: "orders", label: "Orders", value: all?.total ?? 0, kind: "count" },
        { key: "voided", label: "Voided orders", value: all?.voided ?? 0, kind: "count" },
        { key: "openToClose", label: "Average minutes to close", value: all?.openToClose ?? null, kind: "minutes" },
      ];
    }
    case "fulfillment": {
      const all = rowWhere(sectionOf(sections, "stations"), "station", "All stations");

      return [
        { key: "items", label: "Items prepared", value: all?.items ?? 0, kind: "count" },
        { key: "readyAverage", label: "Average minutes to ready", value: all?.readyAverage ?? null, kind: "minutes" },
        { key: "late", label: "Late items", value: all?.late ?? 0, kind: "count" },
      ];
    }
    case "labor": {
      const summary = sectionOf(sections, "summary")?.rows[0];
      const actual = sectionOf(sections, "actual")?.rows[0];

      return [
        { key: "hours", label: "Scheduled hours", value: summary?.hours ?? "0.0000", kind: "hours" },
        { key: "workedHours", label: "Worked hours", value: actual?.workedHours ?? "0.0000", kind: "hours" },
        // Cost and labor % can reveal a wage, so they need hr.compensation.view too.
        ...(context.canViewCompensation
          ? [{ key: "cost", label: "Scheduled labor cost", value: summary?.cost ?? "0.00", kind: "money" as const }]
          : []),
        ...(context.canViewSales && context.canViewCompensation
          ? [{ key: "laborPercent", label: "Labor % of sales", value: summary?.laborPercent ?? null, kind: "percent" as const }]
          : []),
      ];
    }
    case "seating": {
      const all = rowWhere(sectionOf(sections, "sessions"), "area", "All areas");

      return [
        { key: "sessions", label: "Parties seated", value: all?.sessions ?? 0, kind: "count" },
        { key: "covers", label: "Covers", value: all?.covers ?? 0, kind: "count" },
        { key: "averageDuration", label: "Average minutes seated", value: all?.averageDuration ?? null, kind: "minutes" },
      ];
    }
    case "inventory": {
      const usage = sectionOf(sections, "usage")?.rows ?? [];
      const wasteLines = sectionOf(sections, "waste")?.rows.length ?? 0;
      const tiles: DashboardTile[] = [
        { key: "itemsMoved", label: "Items with movement", value: usage.length, kind: "count" },
        { key: "wasteLines", label: "Waste entries (item, reason)", value: wasteLines, kind: "count" },
      ];

      if (context.canViewCost) {
        const wasteCost = usage.reduce<string>(
          (sum, row) => (typeof row.wasteCost === "string" ? addDecimals(sum, row.wasteCost) : sum),
          "0.0000",
        );

        tiles.push({ key: "wasteCost", label: "Waste cost", value: wasteCost, kind: "cost" });
      }

      return tiles;
    }
    case "tips": {
      const day = sectionOf(sections, "byDate")?.rows[0];

      return [
        { key: "tips", label: "Tips", value: day?.tips ?? "0.00", kind: "money" },
        { key: "distributed", label: "Tips distributed", value: day?.distributed ?? "0.00", kind: "money" },
      ];
    }
    default:
      return [];
  }
}

/** Today's business date at a Location, from BusinessDateService: the default report date. */
export async function currentBusinessDate(database: Database, actor: Actor, locationId: string): Promise<string> {
  if (actor.locationId !== locationId || !holds(actor, "reports.view")) {
    throw new AuthorizationError();
  }

  return withReadOnlySnapshot(database, async (tx) => {
    const { settings } = await loadLocationClock(tx, locationId);

    return businessDateOf(new Date(), settings);
  });
}

/**
 * Employees who have worked at the Location, for the report employee filter: number and
 * display name only, never HR or compensation data.
 */
export async function listReportEmployees(
  database: Database,
  actor: Actor,
  locationId: string,
): Promise<{ id: string; label: string }[]> {
  if (actor.locationId !== locationId || !holds(actor, "reports.view")) {
    throw new AuthorizationError();
  }

  return withReadOnlySnapshot(database, async (tx) => {
    const rows = await tx.execute<{ id: string; employee_number: string; name: string }>(sql`
      SELECT DISTINCT e.id, e.employee_number,
             COALESCE(e.preferred_name, e.first_name) || ' ' || e.last_name AS name
      FROM employees e
      JOIN employee_locations el ON el.employee_id = e.id
      WHERE el.location_id = ${locationId}
      ORDER BY name, e.employee_number
    `);

    return [...rows].map((row) => ({ id: row.id, label: `${row.name} (${row.employee_number})` }));
  });
}
