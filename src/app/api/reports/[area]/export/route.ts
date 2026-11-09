import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { exportReportCsv } from "@/modules/reporting/services/report-service";
import { type ReportArea } from "@/modules/reporting/types";
import {
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
    const filters = parseWith(reportFiltersSchema, rest);
    const options = parseWith(exportQuerySchema, { section });
    const actor = await requireApiPermission("reports.export", filters.locationId);
    const { fileName, csv } = await exportReportCsv(getDatabase(), actor, area, filters, options.section);

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
