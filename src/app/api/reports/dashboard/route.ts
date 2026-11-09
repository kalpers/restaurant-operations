import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { buildDashboard } from "@/modules/reporting/services/report-service";
import { dashboardQuerySchema, searchParamsToObject } from "@/modules/reporting/validators/report-filters";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Headline figures for one business date, for each report area the user may view. */
export const GET = apiRoute(
  { module: "reporting", operation: "dashboard" },
  async ({ request }) => {
    const query = parseWith(dashboardQuerySchema, searchParamsToObject(new URL(request.url).searchParams));
    const actor = await requireApiPermission("reports.view", query.locationId);

    return {
      response: Response.json(await buildDashboard(getDatabase(), actor, query.locationId, query.businessDate), {
        headers: { "Cache-Control": "private, no-store" },
      }),
    };
  },
);
