import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { ReportTabs } from "@/components/reports/report-tabs";
import { ReportView } from "@/components/reports/report-view";
import { getDatabase } from "@/db";
import { requirePageUser, resolveCurrentLocation } from "@/modules/auth/guards";
import { requirePermission } from "@/modules/auth/services/permission-service";
import {
  ALL_LOCATIONS,
  CROSS_LOCATION_AREAS,
  crossLocationScope,
  runCrossLocationReport,
} from "@/modules/reporting/services/cross-location-service";
import {
  currentBusinessDate,
  listReportEmployees,
  permittedAreas,
  runReport,
} from "@/modules/reporting/services/report-service";
import {
  ORDER_TYPES,
  REPORT_AREA_PERMISSION,
  REPORT_AREA_TITLE,
  TENDER_TYPES,
  type ReportArea,
  type ReportFilters,
  type ReportResult,
} from "@/modules/reporting/types";
import { reportAreaParamsSchema, reportFiltersSchema } from "@/modules/reporting/validators/report-filters";
import { AppError } from "@/shared/errors/app-error";
import { INPUT_BASE } from "@/components/ui/field";
import { Breadcrumbs } from "@/components/ui/page-header";
import { SectionsSkeleton } from "@/components/ui/skeleton";
import type { Actor, AuthContext } from "@/modules/auth/types";

const INPUT_CLASS = INPUT_BASE;

const ORDER_TYPE_FILTER: readonly ReportArea[] = ["sales", "menu", "orders", "fulfillment"];
const EMPLOYEE_FILTER: readonly ReportArea[] = ["orders", "labor"];

const ORDER_TYPE_LABEL: Record<string, string> = { DINE_IN: "Dine-in", BAR: "Bar", TAKEOUT: "Takeout" };
const TENDER_LABEL: Record<string, string> = {
  CASH: "Cash",
  EXTERNAL_CARD: "Card (external)",
  GIFT_CARD: "Gift card",
  HOUSE_ACCOUNT: "House account",
  OTHER: "Other",
};

function toQuery(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    if (value) {
      params.set(key, value);
    }
  }

  const text = params.toString();

  return text ? `?${text}` : "";
}

/** One report area. Read-only; the page and the APIs each check permissions themselves. */
export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ area: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parsedArea = reportAreaParamsSchema.safeParse(await params);

  if (!parsedArea.success) {
    notFound();
  }

  const area = parsedArea.data.area;
  const permission = REPORT_AREA_PERMISSION[area];
  const auth = await requirePageUser();
  const current = await resolveCurrentLocation(auth);
  const locations = auth.locations.filter(
    (location) => location.permissions.includes("reports.view") && location.permissions.includes(permission),
  );

  if (locations.length === 0) {
    redirect("/access-denied");
  }

  const raw = Object.fromEntries(
    Object.entries(await searchParams).flatMap(([key, value]) =>
      typeof value === "string" && value !== "" ? [[key, value]] : [],
    ),
  ) as Record<string, string>;
  const location =
    locations.find((candidate) => candidate.locationId === raw.locationId) ??
    locations.find((candidate) => candidate.locationId === current?.locationId) ??
    locations[0]!;
  const actor = requirePermission(auth, { permission, locationId: location.locationId });
  const database = getDatabase();
  // Phase 23 (policy 7): "All my locations" for users who can see this area at two or more.
  const canCompare =
    (CROSS_LOCATION_AREAS as readonly string[]).includes(area) &&
    (await crossLocationScope(database, auth, area)).length >= 2;
  const showAll = canCompare && raw.locationId === ALL_LOCATIONS;
  const today = await currentBusinessDate(database, actor, location.locationId);
  const from = raw.from ?? today;
  const to = raw.to ?? from;
  const parsed = reportFiltersSchema.safeParse({
    locationId: location.locationId,
    from,
    to,
    employeeId: EMPLOYEE_FILTER.includes(area) ? raw.employeeId : undefined,
    orderType: ORDER_TYPE_FILTER.includes(area) ? raw.orderType : undefined,
    tenderType: area === "settlements" ? raw.tenderType : undefined,
  });
  const employees = EMPLOYEE_FILTER.includes(area)
    ? await listReportEmployees(database, actor, location.locationId)
    : [];
  const filterQuery = parsed.success
    ? {
        locationId: parsed.data.locationId,
        from: parsed.data.from,
        to: parsed.data.to,
        employeeId: parsed.data.employeeId,
        orderType: parsed.data.orderType,
        tenderType: parsed.data.tenderType,
      }
    : { locationId: location.locationId, from: today, to: today };
  const canExport = location.permissions.includes("reports.export");
  const exportHref = canExport
    ? showAll
      ? () => `/api/reports/${area}/export${toQuery({ locationId: ALL_LOCATIONS, from: filterQuery.from, to: filterQuery.to })}`
      : (section?: string) => `/api/reports/${area}/export${toQuery({ ...filterQuery, section })}`
    : null;

  return (
    <>
      <Breadcrumbs items={[{ label: "Reports", href: "/reports" }, { label: REPORT_AREA_TITLE[area] }]} />
      <h1 className="mb-1 text-2xl font-semibold">{REPORT_AREA_TITLE[area]}</h1>
      <p className="mb-4 text-neutral-600">
        {showAll ? "All my locations" : location.locationName} · business dates {filterQuery.from} to {filterQuery.to}
      </p>
      <ReportTabs
        areas={permittedAreas(actor)}
        current={area}
        query={toQuery({ locationId: filterQuery.locationId, from: filterQuery.from, to: filterQuery.to })}
      />

      <form method="get" aria-label="Report filters" className="mb-6 flex flex-wrap items-end gap-3">
        {locations.length > 1 || canCompare ? (
          <label className="grid gap-1 text-sm font-medium">
            Location
            <select name="locationId" defaultValue={showAll ? ALL_LOCATIONS : location.locationId} className={INPUT_CLASS}>
              {locations.map((candidate) => (
                <option key={candidate.locationId} value={candidate.locationId}>
                  {candidate.locationName}
                </option>
              ))}
              {canCompare && <option value={ALL_LOCATIONS}>All my locations</option>}
            </select>
          </label>
        ) : (
          <input type="hidden" name="locationId" value={location.locationId} />
        )}
        <label className="grid gap-1 text-sm font-medium">
          From business date
          <input type="date" name="from" defaultValue={from} required className={INPUT_CLASS} />
        </label>
        <label className="grid gap-1 text-sm font-medium">
          To business date
          <input type="date" name="to" defaultValue={to} required className={INPUT_CLASS} />
        </label>
        {ORDER_TYPE_FILTER.includes(area) && (
          <label className="grid gap-1 text-sm font-medium">
            Order type
            <select name="orderType" defaultValue={raw.orderType ?? ""} className={INPUT_CLASS}>
              <option value="">All order types</option>
              {ORDER_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ORDER_TYPE_LABEL[type]}
                </option>
              ))}
            </select>
          </label>
        )}
        {area === "settlements" && (
          <label className="grid gap-1 text-sm font-medium">
            Tender type
            <select name="tenderType" defaultValue={raw.tenderType ?? ""} className={INPUT_CLASS}>
              <option value="">All tender types</option>
              {TENDER_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TENDER_LABEL[type]}
                </option>
              ))}
            </select>
          </label>
        )}
        {EMPLOYEE_FILTER.includes(area) && (
          <label className="grid gap-1 text-sm font-medium">
            {area === "orders" ? "Server" : "Employee"}
            <select name="employeeId" defaultValue={raw.employeeId ?? ""} className={INPUT_CLASS}>
              <option value="">All employees</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" className="min-h-11 rounded-md border border-neutral-300 px-4 font-medium">
          Run report
        </button>
        {exportHref && parsed.success && (
          <a
            href={exportHref()}
            className="inline-flex min-h-11 items-center rounded-md border border-brand-700 bg-brand-700 px-4 font-medium text-white shadow-sm hover:bg-brand-800"
          >
            Export all as CSV
          </a>
        )}
      </form>

      {parsed.success ? (
        <Suspense
          key={JSON.stringify(filterQuery)}
          fallback={<SectionsSkeleton label="Loading report" />}
        >
          {showAll ? (
            <CrossLocationResults
              auth={auth}
              area={area}
              filters={{ from: parsed.data.from, to: parsed.data.to }}
              exportHref={exportHref}
            />
          ) : (
            <ReportResults actor={actor} area={area} filters={parsed.data} exportHref={exportHref} />
          )}
        </Suspense>
      ) : (
        <ReportErrorText error="Check the filters: dates must be valid." />
      )}
    </>
  );
}

function ReportErrorText({ error }: { error: string }) {
  return (
    <p role="alert" className="mb-4 rounded border border-danger-300 bg-danger-50 p-3 text-danger-800">
      {error}
    </p>
  );
}

/** Streams in after the filters render, so a slow range shows a placeholder first. */
async function ReportResults({
  actor,
  area,
  filters,
  exportHref,
}: {
  actor: Actor;
  area: ReportArea;
  filters: ReportFilters;
  exportHref: ((section?: string) => string) | null;
}) {
  let report: ReportResult;

  try {
    report = await runReport(getDatabase(), actor, area, filters);
  } catch (caught) {
    if (caught instanceof AppError && caught.httpStatus < 500) {
      return <ReportErrorText error={caught.message} />;
    }

    throw caught;
  }

  return <ReportView report={report} exportHref={exportHref} />;
}

/** Phase 23 (policy 7): the area's summary figures side by side for every location. */
async function CrossLocationResults({
  auth,
  area,
  filters,
  exportHref,
}: {
  auth: AuthContext;
  area: ReportArea;
  filters: { from: string; to: string };
  exportHref: ((section?: string) => string) | null;
}) {
  let report: ReportResult;

  try {
    report = await runCrossLocationReport(getDatabase(), auth, area, filters);
  } catch (caught) {
    if (caught instanceof AppError && caught.httpStatus < 500) {
      return <ReportErrorText error={caught.message} />;
    }

    throw caught;
  }

  return <ReportView report={report} exportHref={exportHref} />;
}
