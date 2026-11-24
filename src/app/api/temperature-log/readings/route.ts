import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { searchParamsToObject } from "@/modules/reporting/validators/report-filters";
import { listTemperatureReadings, recordTemperatureReading } from "@/modules/restaurant/services/temperature-service";
import {
  recordTemperatureReadingSchema,
  temperatureLogQuerySchema,
} from "@/modules/restaurant/validators/temperature-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 6): the temperature log for up to 31 days. */
export const GET = apiRoute({ module: "restaurant", operation: "list-temperature-readings" }, async ({ request }) => {
  const actor = await requireApiActor();
  const query = parseWith(temperatureLogQuerySchema, searchParamsToObject(new URL(request.url).searchParams));

  return { body: { readings: await listTemperatureReadings(getDatabase(), actor, query) } };
});

/** Records one reading; a retry with the same key records nothing more. */
export const POST = apiRoute({ module: "restaurant", operation: "record-temperature-reading" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, recordTemperatureReadingSchema);
  const result = await recordTemperatureReading(getDatabase(), actor, body);

  return { body: result, status: result.replayed ? 200 : 201 };
});
