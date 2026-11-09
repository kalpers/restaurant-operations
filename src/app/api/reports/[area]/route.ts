import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { runReport } from "@/modules/reporting/services/report-service";
import { REPORT_AREA_PERMISSION, type ReportArea } from "@/modules/reporting/types";
import {
  reportAreaParamsSchema,
  reportFiltersSchema,
  searchParamsToObject,
} from "@/modules/reporting/validators/report-filters";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** One report as JSON. Read-only; authorized at the requested Location. */
export const GET = apiRoute<{ area: string }>(
  { module: "reporting", operation: "run-report" },
  async ({ request, params }) => {
    const { area } = parseWith(reportAreaParamsSchema, params) as { area: ReportArea };
    const filters = parseWith(reportFiltersSchema, searchParamsToObject(new URL(request.url).searchParams));
    const actor = await requireApiPermission(REPORT_AREA_PERMISSION[area], filters.locationId);

    return {
      response: Response.json(await runReport(getDatabase(), actor, area, filters), {
        headers: { "Cache-Control": "private, no-store" },
      }),
    };
  },
);
