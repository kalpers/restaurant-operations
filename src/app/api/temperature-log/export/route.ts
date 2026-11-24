import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { searchParamsToObject } from "@/modules/reporting/validators/report-filters";
import { exportTemperatureLogCsv } from "@/modules/restaurant/services/temperature-service";
import { temperatureLogQuerySchema } from "@/modules/restaurant/validators/temperature-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 6): the temperature log as CSV, for inspectors. */
export const GET = apiRoute({ module: "restaurant", operation: "export-temperature-log" }, async ({ request }) => {
  const actor = await requireApiActor();
  const query = parseWith(temperatureLogQuerySchema, searchParamsToObject(new URL(request.url).searchParams));
  const { fileName, csv } = await exportTemperatureLogCsv(getDatabase(), actor, query);

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
});
