import type { Database } from "@/db";
import { withReadOnlySnapshot, withTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor, AuthContext } from "@/modules/auth/types";
import { weekStartOf } from "@/modules/scheduling/rules/schedule-rules";
import { AuthorizationError, BusinessRuleError } from "@/shared/errors/app-error";
import { businessDateOf } from "@/shared/time/business-date-service";
import { addDays } from "@/shared/time/zoned-time";

import { loadPayrollFacts, loadWeekStartDay } from "../queries/payroll-hours";
import { loadLocationClock, loadReportContext } from "../queries/report-context";
import { loadJournalFacts } from "../queries/sales-journal";
import { loadHolderReport } from "../queries/unclaimed-holder-report";
import { csvLine } from "../rules/csv";
import { buildPayrollRows, MAXIMUM_PAYROLL_WEEKS, wholeWeeks, type PayrollRow } from "../rules/payroll-hours";
import { assertValidRange } from "../rules/period";
import { buildJournalDay, JournalOutOfBalance, type JournalRow } from "../rules/sales-journal";
import type { ReportCell } from "../types";
import { crossLocationScope } from "./cross-location-service";

// Phase 28 exports (policies 8 to 10). Two CSV files for the bookkeeper and the payroll
// provider: plain tables with stable snake_case headers and no title block, so they load
// without retyping. Read-only (one REPEATABLE READ snapshot), permission-checked at every
// included location, and audited as `reports.exported` in a short write afterwards; if the
// audit can't be written, the export is refused. Never a wage, rate, contact detail or note.
// Phase 34 (policy 5, amendment 2): a third file, the gift card holder report, which carries
// purchaser details by design and so needs `gift-cards.purchaser.view`; organization-wide.

export type ExportKind = "journal" | "payroll" | "unclaimed";

export const EXPORT_PERMISSIONS: Record<ExportKind, readonly PermissionCode[]> = {
  journal: ["reports.view", "reports.export", "reports.sales", "reports.settlements"],
  payroll: ["reports.view", "reports.export", "reports.labor"],
  unclaimed: ["reports.view", "reports.export", "reports.settlements", "gift-cards.purchaser.view"],
};

export const ALL_LOCATIONS = "ALL";

type Scope = { actor: Actor; locationCode: string };

const holdsAll = (permissions: readonly string[], kind: ExportKind) =>
  EXPORT_PERMISSIONS[kind].every((permission) => permissions.includes(permission));

/** The locations an export covers, each with an actor resolved there. */
async function scopeOf(database: Database, auth: AuthContext, kind: ExportKind, locationId: string): Promise<Scope[]> {
  if (locationId === ALL_LOCATIONS && kind === "unclaimed") {
    throw new BusinessRuleError("EXPORT_ORGANIZATION_WIDE", "The holder report already covers all locations. Choose this location.");
  }

  if (locationId === ALL_LOCATIONS) {
    const included = (await crossLocationScope(database, auth, kind === "journal" ? "sales" : "labor")).filter((entry) =>
      holdsAll(entry.location.permissions, kind),
    );

    if (included.filter((entry) => !entry.closed).length === 0) {
      throw new AuthorizationError();
    }

    return included.map((entry) => ({ actor: entry.actor, locationCode: entry.location.locationCode }));
  }

  const location = auth.locations.find((entry) => entry.locationId === locationId);

  if (!location || !holdsAll(location.permissions, kind)) {
    throw new AuthorizationError();
  }

  return [
    {
      actor: {
        userId: auth.userId,
        organizationId: location.organizationId,
        locationId: location.locationId,
        permissions: new Set(location.permissions),
      },
      locationCode: location.locationCode,
    },
  ];
}

function toCsv(header: readonly string[], rows: readonly (readonly ReportCell[])[]): string {
  return `${[csvLine(header), ...rows.map((row) => csvLine(row))].join("\r\n")}\r\n`;
}

const safe = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, "");

async function audit(scopes: Scope[], kind: ExportKind, all: boolean, from: string, to: string, rowCount: number, database: Database) {
  await withTransaction(database, (transaction) =>
    recordAudit(transaction, scopes[0]!.actor, {
      action: "reports.exported",
      entityId: null,
      details: { area: `exports:${kind}${all ? ":all-locations" : ""}`, from, to, rowCount },
    }),
  );
}

/** Policy 8: the daily sales and tax journal. Refused if any date doesn't balance. */
export async function exportSalesJournal(
  database: Database,
  auth: AuthContext,
  input: { locationId: string; from: string; to: string },
): Promise<{ fileName: string; csv: string }> {
  assertValidRange(input.from, input.to);

  const all = input.locationId === ALL_LOCATIONS;
  const scopes = await scopeOf(database, auth, "journal", input.locationId);
  const rows = await withReadOnlySnapshot(database, async (tx) => {
    const lines: (JournalRow & { locationCode: string })[] = [];

    for (const scope of scopes) {
      const context = await loadReportContext(tx, scope.actor, {
        locationId: scope.actor.locationId,
        from: input.from,
        to: input.to,
      });

      for (const day of await loadJournalFacts(context)) {
        try {
          lines.push(...buildJournalDay(day).map((line) => ({ ...line, locationCode: scope.locationCode })));
        } catch (error) {
          if (error instanceof JournalOutOfBalance) {
            throw new BusinessRuleError(
              "JOURNAL_OUT_OF_BALANCE",
              `The journal for ${scope.locationCode} on ${error.businessDate} doesn't balance (debits ${error.debits}, credits ${error.credits}), so it wasn't exported. Contact an administrator.`,
            );
          }

          throw error;
        }
      }
    }

    return lines;
  });
  const header = [...(all ? ["location_code"] : []), "business_date", "line_type", "code", "debit", "credit"];
  const csv = toCsv(
    header,
    rows.map((row) => [...(all ? [row.locationCode] : []), row.businessDate, row.lineType, row.code, row.debit, row.credit]),
  );

  await audit(scopes, "journal", all, input.from, input.to, rows.length, database);

  return {
    fileName: `sales-journal_${all ? "ALL" : safe(scopes[0]!.locationCode)}_${input.from}_${input.to}.csv`,
    csv,
  };
}

/** Policy 9: hours by employee, position and overtime week, whole weeks only. */
export async function exportPayrollHours(
  database: Database,
  auth: AuthContext,
  input: { locationId: string; from: string; to: string },
): Promise<{ fileName: string; csv: string }> {
  const all = input.locationId === ALL_LOCATIONS;
  const scopes = await scopeOf(database, auth, "payroll", input.locationId);
  const tipsEverywhere = scopes.every(
    (scope) => scope.actor.permissions.has("reports.tips") || scope.actor.permissions.has("tips.manage"),
  );
  const rows = await withReadOnlySnapshot(database, async (tx) => {
    const result: (PayrollRow & { locationCode: string })[] = [];

    for (const scope of scopes) {
      const context = await loadReportContext(tx, scope.actor, {
        locationId: scope.actor.locationId,
        from: input.from,
        to: input.to,
      });
      const weekStartDay = await loadWeekStartDay(context);

      if (wholeWeeks(input.from, input.to, (date) => weekStartOf(date, weekStartDay)) === null) {
        throw new BusinessRuleError(
          "PAYROLL_RANGE_NOT_WHOLE_WEEKS",
          `Choose 1 to ${MAXIMUM_PAYROLL_WEEKS} whole work weeks, starting on the first day of the week set in scheduling rules.`,
        );
      }

      const facts = await loadPayrollFacts(context);

      if (facts.openEntries.length > 0) {
        const listed = facts.openEntries
          .slice(0, 10)
          .map((entry) => `${entry.employeeNumber} on ${entry.businessDate}`)
          .join(", ");

        throw new BusinessRuleError(
          "TIME_ENTRIES_OPEN",
          `Close these time entries first (${scope.locationCode}): ${listed}${facts.openEntries.length > 10 ? ", and more" : ""}. An open entry counts no hours.`,
        );
      }

      result.push(
        ...buildPayrollRows({
          entries: facts.entries,
          weekStartOf: (date) => weekStartOf(date, facts.weekStartDay),
          employees: facts.employees,
          positions: facts.positions,
          tips: tipsEverywhere ? facts.tips : null,
        }).map((row) => ({ ...row, locationCode: scope.locationCode })),
      );
    }

    return result;
  });
  const header = [
    ...(all ? ["location_code"] : []),
    "week_start",
    "employee_number",
    "employee_name",
    "position_code",
    "regular_hours",
    "overtime_hours",
    "total_hours",
    ...(tipsEverywhere ? ["tip_share", "declared_tips", "tips_finalized"] : []),
  ];
  const csv = toCsv(
    header,
    rows.map((row) => [
      ...(all ? [row.locationCode] : []),
      row.weekStart,
      row.employeeNumber,
      row.employee,
      row.positionCode,
      row.regularHours,
      row.overtimeHours,
      row.totalHours,
      ...(tipsEverywhere ? [row.tipShare ?? "0.00", row.declaredTips ?? "0.00", row.tipsFinalized ?? "NO"] : []),
    ]),
  );

  await audit(scopes, "payroll", all, input.from, input.to, rows.length, database);

  return {
    fileName: `payroll-hours_${all ? "ALL" : safe(scopes[0]!.locationCode)}_${input.from}_${input.to}.csv`,
    csv,
  };
}

const UNKNOWN = "UNKNOWN";
const orUnknown = (value: string | null) => value?.trim() || UNKNOWN;

/**
 * Phase 34 (policy 5): the holder report: every unused balance as of `to`, organization-wide,
 * with the selling location's address and the purchaser's details, or UNKNOWN for each one
 * missing. Material for a filing, not a filing: no state's form or property codes.
 */
export async function exportHolderReport(
  database: Database,
  auth: AuthContext,
  input: { locationId: string; from: string; to: string },
): Promise<{ fileName: string; csv: string }> {
  const scopes = await scopeOf(database, auth, "unclaimed", input.locationId);
  const report = await withReadOnlySnapshot(database, async (tx) =>
    loadHolderReport(await loadReportContext(tx, scopes[0]!.actor, { locationId: scopes[0]!.actor.locationId, from: input.to, to: input.to })),
  );
  const header = [
    "card_number",
    "first_sold_date",
    "last_activity_date",
    "balance",
    "dormancy_months",
    "sold_at_location_code",
    "sold_at_location_name",
    "sold_at_address_line1",
    "sold_at_address_line2",
    "sold_at_city",
    "sold_at_state",
    "sold_at_postal_code",
    "sold_at_country",
    "owner_name",
    "owner_email",
    "owner_phone",
    "owner_address_line1",
    "owner_address_line2",
    "owner_city",
    "owner_region",
    "owner_postal_code",
    "owner_country",
  ];
  const csv = toCsv(
    header,
    report.rows.map((row) => [
      `GC-${String(row.cardNumber).padStart(6, "0")}`,
      row.firstSold ?? "",
      row.lastActivity,
      row.balance,
      String(report.dormancyMonths),
      row.soldAtCode,
      row.soldAtName,
      row.soldAtAddress.line1 ?? "",
      row.soldAtAddress.line2 ?? "",
      row.soldAtAddress.city ?? "",
      row.soldAtAddress.state ?? "",
      row.soldAtAddress.postalCode ?? "",
      row.soldAtAddress.country ?? "",
      orUnknown(row.purchaser.name),
      orUnknown(row.purchaser.email),
      orUnknown(row.purchaser.phone),
      orUnknown(row.purchaser.line1),
      row.purchaser.line2 ?? "",
      orUnknown(row.purchaser.city),
      orUnknown(row.purchaser.region),
      orUnknown(row.purchaser.postalCode),
      orUnknown(row.purchaser.country),
    ]),
  );

  await audit(scopes, "unclaimed", false, input.to, input.to, report.rows.length, database);

  return { fileName: `gift-card-holder-report_${input.to}.csv`, csv };
}

/** What the Exports page may offer: which files, and whether "All my locations" applies. */
export function exportAbilities(auth: AuthContext, locationId: string) {
  const here = auth.locations.find((entry) => entry.locationId === locationId);
  const count = (kind: ExportKind) => auth.locations.filter((entry) => holdsAll(entry.permissions, kind)).length;

  return {
    journal: here ? holdsAll(here.permissions, "journal") : false,
    payroll: here ? holdsAll(here.permissions, "payroll") : false,
    unclaimed: here ? holdsAll(here.permissions, "unclaimed") : false,
    journalAllLocations: count("journal") >= 2,
    payrollAllLocations: count("payroll") >= 2,
  };
}

/** Default ranges for the Exports page: yesterday for the journal, last whole week for payroll. */
export async function exportDefaults(database: Database, actor: Actor) {
  return withReadOnlySnapshot(database, async (tx) => {
    const { settings } = await loadLocationClock(tx, actor.locationId);
    const today = businessDateOf(new Date(), settings);
    const yesterday = addDays(today, -1);
    const context = await loadReportContext(tx, actor, { locationId: actor.locationId, from: yesterday, to: yesterday });
    const weekStartDay = await loadWeekStartDay(context);
    const lastWeek = addDays(weekStartOf(today, weekStartDay), -7);

    return {
      journal: { from: yesterday, to: yesterday },
      payroll: { from: lastWeek, to: addDays(lastWeek, 6) },
      weekStartDay,
    };
  });
}
