import { eq, type SQL } from "drizzle-orm";

import { locations, locationSettings } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { NotFoundError } from "@/shared/errors/app-error";
import {
  businessDateRangeBounds,
  type BusinessDateSettings,
} from "@/shared/time/business-date-service";

import type { ReportFilters } from "../types";

/** Everything a report query needs, resolved once inside the read-only snapshot. */
export type ReportContext = {
  tx: DatabaseTransaction;
  filters: ReportFilters;
  location: { id: string; code: string; name: string };
  settings: BusinessDateSettings;
  /**
   * The instants `[start, end)` of the business-date range, from BusinessDateService, for
   * sources stored only as instants (kitchen items, sessions, reservations, waitlist), as
   * ISO strings for query parameters.
   */
  start: string;
  end: string;
  /** Cost columns need `inventory.cost.view` (Phase 8 cost visibility). */
  canViewCost: boolean;
  /** Per-employee labor cost needs `hr.compensation.view` (approved Phase 12 policy). */
  canViewCompensation: boolean;
  /** Labor % of sales needs `reports.sales`. */
  canViewSales: boolean;
  /** Per-server tip figures need `reports.tips` or `tips.manage` (Phase 18 rule). */
  canViewTips: boolean;
};

/** The Location's name and business-date clock. */
export async function loadLocationClock(tx: DatabaseTransaction, locationId: string) {
  const [row] = await tx
    .select({
      id: locations.id,
      code: locations.locationCode,
      name: locations.name,
      timeZone: locations.timezone,
      businessDayCutoff: locationSettings.businessDayCutoff,
    })
    .from(locations)
    .innerJoin(locationSettings, eq(locationSettings.locationId, locations.id))
    .where(eq(locations.id, locationId));

  if (!row) {
    throw new NotFoundError("Location not found.");
  }

  return {
    location: { id: row.id, code: row.code, name: row.name },
    settings: { timeZone: row.timeZone, businessDayCutoff: row.businessDayCutoff } as BusinessDateSettings,
  };
}

export async function loadReportContext(
  tx: DatabaseTransaction,
  actor: Actor,
  filters: ReportFilters,
): Promise<ReportContext> {
  const { location, settings } = await loadLocationClock(tx, filters.locationId);
  const { start, end } = businessDateRangeBounds(filters.from, filters.to, settings);

  return {
    tx,
    filters,
    location,
    settings,
    start: start.toISOString(),
    end: end.toISOString(),
    canViewCost: actor.permissions.has("inventory.cost.view"),
    canViewCompensation: actor.permissions.has("hr.compensation.view"),
    canViewSales: actor.permissions.has("reports.sales"),
    canViewTips: actor.permissions.has("reports.tips") || actor.permissions.has("tips.manage"),
  };
}

/** Runs an aggregation query and returns its rows (postgres-js returns an array). */
export async function rowsOf<Row>(context: ReportContext, query: SQL): Promise<Row[]> {
  return [...((await context.tx.execute(query)) as unknown as Row[])];
}

/** Rounds a minutes figure from SQL (a numeric string or null) to one place. */
export function minutes(value: string | number | null): number | null {
  return value === null ? null : Math.round(Number(value) * 10) / 10;
}
