import type { Database } from "@/db";
import { withReadOnlySnapshot, withTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import { findClosedLocationReportGrants } from "@/modules/auth/services/permission-service";
import type { Actor, AuthContext, AuthorizedLocation } from "@/modules/auth/types";
import { addDecimals, divideRoundHalfUp, toScale } from "@/shared/decimal/decimal";
import { AuthorizationError, BusinessRuleError } from "@/shared/errors/app-error";
import { businessDateOf } from "@/shared/time/business-date-service";

import { loadLocationClock, loadReportContext, type ReportContext } from "../queries/report-context";
import { csvFileName, reportToCsv } from "../rules/csv";
import { assertValidRange } from "../rules/period";
import {
  REPORT_AREA_PERMISSION,
  REPORT_AREA_TITLE,
  type ColumnKind,
  type ReportArea,
  type ReportCell,
  type ReportFilters,
  type ReportResult,
  type ReportRow,
  type ReportSection,
} from "../types";
import { BUILDERS } from "./report-service";

// Phase 23 (policies 7–9, D6): "All my locations". One row per location where the user holds
// the area's report permission, plus a total, for each area's summary figures. Each location's
// figures come from its own report, run for the same business dates on its own clock, all in
// one read-only snapshot. Totals add the additive figures; an average check is worked out from
// the summed sales and checks; other averages are shown per location only (amendment 4). Cost
// and wage figures appear only if the user may see them at every included location.

export const CROSS_LOCATION_AREAS = [
  "sales",
  "settlements",
  "orders",
  "fulfillment",
  "labor",
  "seating",
  "inventory",
  "tips",
] as const satisfies readonly ReportArea[];

export type CrossLocationArea = (typeof CROSS_LOCATION_AREAS)[number];

export const ALL_LOCATIONS = "ALL";

type Figure = {
  key: string;
  label: string;
  kind: ColumnKind;
  /** How the total row gets its value. */
  total: "sum" | "none" | { ratio: [string, string] };
  /** Shown only when every included location allows it. */
  needs?: "cost" | "compensation";
};

const FIGURES: Record<CrossLocationArea, Figure[]> = {
  sales: [
    { key: "netSales", label: "Net sales", kind: "money", total: "sum" },
    { key: "tax", label: "Tax", kind: "money", total: "sum" },
    { key: "discounts", label: "Discounts", kind: "money", total: "sum" },
    { key: "comps", label: "Of which comps", kind: "money", total: "sum" },
    { key: "closedOrders", label: "Closed checks", kind: "count", total: "sum" },
    { key: "covers", label: "Covers", kind: "count", total: "sum" },
    { key: "averageCheck", label: "Average check", kind: "money", total: { ratio: ["netSales", "closedOrders"] } },
    { key: "openChecks", label: "Open checks", kind: "count", total: "sum" },
  ],
  settlements: [
    { key: "tendered", label: "Tendered", kind: "money", total: "sum" },
    { key: "tips", label: "Tips", kind: "money", total: "sum" },
    { key: "tenders", label: "Tenders", kind: "count", total: "sum" },
  ],
  orders: [
    { key: "orders", label: "Orders", kind: "count", total: "sum" },
    { key: "voided", label: "Voided orders", kind: "count", total: "sum" },
    { key: "openToClose", label: "Average minutes to close", kind: "minutes", total: "none" },
  ],
  fulfillment: [
    { key: "items", label: "Items prepared", kind: "count", total: "sum" },
    { key: "late", label: "Late items", kind: "count", total: "sum" },
    { key: "readyAverage", label: "Average minutes to ready", kind: "minutes", total: "none" },
  ],
  labor: [
    { key: "hours", label: "Scheduled hours", kind: "hours", total: "sum" },
    { key: "workedHours", label: "Worked hours", kind: "hours", total: "sum" },
    { key: "cost", label: "Scheduled labor cost", kind: "money", total: "sum", needs: "compensation" },
  ],
  seating: [
    { key: "sessions", label: "Parties seated", kind: "count", total: "sum" },
    { key: "covers", label: "Covers", kind: "count", total: "sum" },
    { key: "averageDuration", label: "Average minutes seated", kind: "minutes", total: "none" },
  ],
  inventory: [
    { key: "itemsMoved", label: "Items with movement", kind: "count", total: "sum" },
    { key: "wasteEntries", label: "Waste entries", kind: "count", total: "sum" },
    { key: "wasteCost", label: "Waste cost", kind: "cost", total: "sum", needs: "cost" },
    { key: "inTransit", label: "Value in transit", kind: "cost", total: "sum", needs: "cost" },
  ],
  tips: [
    { key: "tips", label: "Tips", kind: "money", total: "sum" },
    { key: "distributed", label: "Distributed", kind: "money", total: "sum" },
  ],
};

const section = (sections: ReportSection[], key: string) => sections.find((entry) => entry.key === key);
const rowWhere = (entry: ReportSection | undefined, key: string, value: ReportCell) =>
  entry?.rows.find((row) => row[key] === value);
const sumOf = (rows: ReportRow[] | undefined, key: string, scale: number) =>
  toScale(
    (rows ?? []).reduce<string>((total, row) => (typeof row[key] === "string" ? addDecimals(total, row[key] as string) : total), "0"),
    scale,
  );

/** The area's summary figures from one location's report sections. */
function figuresOf(area: CrossLocationArea, sections: ReportSection[]): ReportRow {
  switch (area) {
    case "sales": {
      const all = rowWhere(section(sections, "summary"), "orderType", "All");

      return {
        netSales: all?.netSales ?? "0.00",
        tax: all?.tax ?? "0.00",
        discounts: all?.discounts ?? "0.00",
        comps: all?.comps ?? "0.00",
        closedOrders: all?.closedOrders ?? 0,
        covers: all?.covers ?? 0,
        averageCheck: all?.averageCheck ?? null,
        openChecks: all?.openChecks ?? 0,
      };
    }
    case "settlements": {
      const all = rowWhere(section(sections, "tenders"), "tenderType", "All");

      return { tendered: all?.amount ?? "0.00", tips: all?.tips ?? "0.00", tenders: all?.tenders ?? 0 };
    }
    case "orders": {
      const all = rowWhere(section(sections, "lifecycle"), "orderType", "All");

      return { orders: all?.total ?? 0, voided: all?.voided ?? 0, openToClose: all?.openToClose ?? null };
    }
    case "fulfillment": {
      const all = rowWhere(section(sections, "stations"), "station", "All stations");

      return { items: all?.items ?? 0, late: all?.late ?? 0, readyAverage: all?.readyAverage ?? null };
    }
    case "labor": {
      const summary = section(sections, "summary")?.rows[0];
      const actual = section(sections, "actual")?.rows[0];

      return { hours: summary?.hours ?? "0.0000", workedHours: actual?.workedHours ?? "0.0000", cost: summary?.cost ?? null };
    }
    case "seating": {
      const all = rowWhere(section(sections, "sessions"), "area", "All areas");

      return { sessions: all?.sessions ?? 0, covers: all?.covers ?? 0, averageDuration: all?.averageDuration ?? null };
    }
    case "inventory": {
      const usage = section(sections, "usage")?.rows;

      return {
        itemsMoved: usage?.length ?? 0,
        wasteEntries: section(sections, "waste")?.rows.length ?? 0,
        wasteCost: sumOf(usage, "wasteCost", 4),
        inTransit: sumOf(section(sections, "in-transit")?.rows, "value", 4),
      };
    }
    case "tips": {
      const days = section(sections, "byDate")?.rows;

      return { tips: sumOf(days, "tips", 2), distributed: sumOf(days, "distributed", 2) };
    }
  }
}

const SCALE: Partial<Record<ColumnKind, number>> = { money: 2, cost: 4, hours: 4, quantity: 4 };

function totalOf(figure: Figure, rows: ReportRow[], totals: ReportRow): ReportCell {
  if (figure.total === "none") {
    return null;
  }

  if (figure.total === "sum") {
    if (figure.kind === "count") {
      return rows.reduce((sum, row) => sum + Number(row[figure.key] ?? 0), 0);
    }

    return toScale(
      rows.reduce<string>((sum, row) => (row[figure.key] == null ? sum : addDecimals(sum, String(row[figure.key]))), "0"),
      SCALE[figure.kind] ?? 2,
    );
  }

  const [numerator, denominator] = figure.total.ratio;
  const den = String(totals[denominator] ?? "0");

  return Number(den) === 0 ? null : divideRoundHalfUp(String(totals[numerator] ?? "0"), den, SCALE[figure.kind] ?? 2);
}

type Included = { location: AuthorizedLocation; closed: boolean; actor: Actor };

/** The locations the user may compare for an area: open ones, and closed ones per policy 7. */
export async function crossLocationScope(database: Database, auth: AuthContext, area: ReportArea): Promise<Included[]> {
  const permission = REPORT_AREA_PERMISSION[area];
  const allowed = (location: AuthorizedLocation) =>
    location.permissions.includes("reports.view") && location.permissions.includes(permission);
  const open = auth.locations.filter(allowed);
  const organizationId = open[0]?.organizationId;

  if (!organizationId) {
    return [];
  }

  // A closed location counts only while the same permissions are held at an open one.
  const closed = (await findClosedLocationReportGrants(database, auth.userId, organizationId)).filter(allowed);
  const toActor = (location: AuthorizedLocation): Actor => ({
    userId: auth.userId,
    organizationId: location.organizationId,
    locationId: location.locationId,
    permissions: new Set(location.permissions),
  });

  const byCode = (a: AuthorizedLocation, b: AuthorizedLocation) => a.locationCode.localeCompare(b.locationCode);

  return [
    ...open
      .filter((location) => location.organizationId === organizationId)
      .sort(byCode)
      .map((location) => ({ location, closed: false, actor: toActor(location) })),
    ...closed.sort(byCode).map((location) => ({ location, closed: true, actor: toActor(location) })),
  ];
}

export async function runCrossLocationReport(
  database: Database,
  auth: AuthContext,
  area: ReportArea,
  filters: Omit<ReportFilters, "locationId">,
): Promise<ReportResult> {
  if (!(CROSS_LOCATION_AREAS as readonly string[]).includes(area)) {
    throw new BusinessRuleError("NOT_COMPARABLE", "This report is shown for one location at a time.");
  }

  const crossArea = area as CrossLocationArea;
  const included = await crossLocationScope(database, auth, area);

  if (included.filter((entry) => !entry.closed).length === 0) {
    throw new AuthorizationError();
  }

  if (included.length < 2) {
    throw new BusinessRuleError("NOT_ENOUGH_LOCATIONS", "You can see this report at only one location.");
  }

  assertValidRange(filters.from, filters.to);

  return withReadOnlySnapshot(database, async (tx) => {
    const rows: ReportRow[] = [];
    let costEverywhere = true;
    let wagesEverywhere = true;

    for (const entry of included) {
      const context: ReportContext = await loadReportContext(tx, entry.actor, { ...filters, locationId: entry.location.locationId });

      costEverywhere &&= context.canViewCost;
      wagesEverywhere &&= context.canViewCompensation;
      rows.push({
        locationCode: entry.location.locationCode,
        location: entry.closed ? `${entry.location.locationName} (closed)` : entry.location.locationName,
        ...figuresOf(crossArea, await BUILDERS[area](context)),
      });
    }

    const figures = FIGURES[crossArea].filter(
      (figure) => (figure.needs !== "cost" || costEverywhere) && (figure.needs !== "compensation" || wagesEverywhere),
    );
    const totals: ReportRow = { locationCode: "", location: "All locations" };

    for (const figure of figures.filter((entry) => entry.total === "sum")) {
      totals[figure.key] = totalOf(figure, rows, totals);
    }

    for (const figure of figures.filter((entry) => entry.total !== "sum")) {
      totals[figure.key] = totalOf(figure, rows, totals);
    }

    const keep = (row: ReportRow): ReportRow =>
      Object.fromEntries(["locationCode", "location", ...figures.map((figure) => figure.key)].map((key) => [key, row[key] ?? null]));
    const notes = [
      "Each location's figures use its own business dates and day cutoff for the dates chosen.",
      "Average minutes are shown for each location; the total leaves them out.",
    ];

    if (figures.length < FIGURES[crossArea].length) {
      notes.push("Cost or wage figures are hidden: they need permission at every location shown.");
    }

    return {
      area,
      title: `${REPORT_AREA_TITLE[area]}: all my locations`,
      location: { id: ALL_LOCATIONS, code: ALL_LOCATIONS, name: "All my locations" },
      filters: { ...filters, locationId: ALL_LOCATIONS },
      notes,
      sections: [
        {
          key: "by-location",
          title: "By location",
          description: `${included.length} locations you can see this report at.`,
          columns: [
            { key: "locationCode", label: "Code", kind: "text" },
            { key: "location", label: "Location", kind: "text" },
            ...figures.map((figure) => ({ key: figure.key, label: figure.label, kind: figure.kind })),
          ],
          rows: [...rows.map(keep), keep(totals)],
        },
      ],
    };
  });
}

/** CSV of the comparison. Needs `reports.export` at every location it includes. */
export async function exportCrossLocationCsv(
  database: Database,
  auth: AuthContext,
  area: ReportArea,
  filters: Omit<ReportFilters, "locationId">,
): Promise<{ fileName: string; csv: string }> {
  const included = await crossLocationScope(database, auth, area);

  if (included.length === 0 || included.some((entry) => !entry.location.permissions.includes("reports.export"))) {
    throw new AuthorizationError();
  }

  const report = await runCrossLocationReport(database, auth, area, filters);
  const auditor = included.find((entry) => !entry.closed)!.actor;

  await withTransaction(database, (transaction) =>
    recordAudit(transaction, auditor, {
      action: "reports.exported",
      entityId: null,
      details: { area: `${area}:all-locations`, from: filters.from, to: filters.to, rowCount: report.sections[0]!.rows.length },
    }),
  );

  return { fileName: csvFileName(report), csv: reportToCsv(report, report.sections) };
}

export type TodayAtLocation = {
  locationId: string;
  name: string;
  businessDate: string;
  netSales: ReportCell;
  closedOrders: ReportCell;
  covers: ReportCell;
  openChecks: ReportCell;
  /** Null when the user can't see seating reports there. */
  seatedParties: ReportCell;
};

/**
 * Phase 23 (policy 8): today at each open location where the user holds the sales report,
 * each on its own current business date. Null with fewer than two such locations.
 */
export async function buildTodayAcrossLocations(database: Database, auth: AuthContext, now = new Date()): Promise<TodayAtLocation[] | null> {
  const included = (await crossLocationScope(database, auth, "sales")).filter((entry) => !entry.closed);

  if (included.length < 2) {
    return null;
  }

  return withReadOnlySnapshot(database, async (tx) => {
    const result: TodayAtLocation[] = [];

    for (const entry of included) {
      const { settings } = await loadLocationClock(tx, entry.location.locationId);
      const businessDate = businessDateOf(now, settings);
      const context = await loadReportContext(tx, entry.actor, {
        locationId: entry.location.locationId,
        from: businessDate,
        to: businessDate,
      });
      const sales = figuresOf("sales", await BUILDERS.sales(context));
      const seating = entry.location.permissions.includes("reports.seating")
        ? figuresOf("seating", await BUILDERS.seating(context))
        : null;

      result.push({
        locationId: entry.location.locationId,
        name: entry.location.locationName,
        businessDate,
        netSales: sales.netSales ?? null,
        closedOrders: sales.closedOrders ?? null,
        covers: sales.covers ?? null,
        openChecks: sales.openChecks ?? null,
        seatedParties: seating?.sessions ?? null,
      });
    }

    return result;
  });
}
