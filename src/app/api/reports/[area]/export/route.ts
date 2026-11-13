import { getDatabase } from "@/db";
import { requireApiPermission, requireCurrentUser } from "@/modules/auth/guards";
import { ALL_LOCATIONS, exportCrossLocationCsv } from "@/modules/reporting/services/cross-location-service";
import { exportReportCsv } from "@/modules/reporting/services/report-service";
import { type ReportArea } from "@/modules/reporting/types";
import {
  crossLocationFiltersSchema,
  exportQuerySchema,
  reportAreaParamsSchema,
  reportFiltersSchema,
  searchParamsToObject,
} from "@/modules/reporting/validators/report-filters";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** One report as a CSV download. Needs `reports.export` and the area's permission. */
export const GET = apiRoute<{ area: string }>(
  { module: "reporting", operation: "export-report" },
  async ({ request, params }) => {
    const { area } = parseWith(reportAreaParamsSchema, params) as { area: ReportArea };
    const query = searchParamsToObject(new URL(request.url).searchParams);
    const { section, ...rest } = query;
    const options = parseWith(exportQuerySchema, { section });
    // Phase 23 (policy 9): "All my locations" exports the comparison.
    const { fileName, csv } =
      rest.locationId === ALL_LOCATIONS
        ? await exportCrossLocationCsv(
            getDatabase(),
            await requireCurrentUser(),
            area,
            parseWith(crossLocationFiltersSchema, rest),
          )
        : await (async () => {
            const filters = parseWith(reportFiltersSchema, rest);
            const actor = await requireApiPermission("reports.export", filters.locationId);

            return exportReportCsv(getDatabase(), actor, area, filters, options.section);
          })();

    return {
      response: new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store",
        },
      }),
    };
  },
);
