import { z } from "zod";

import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { apiRoute, parseWith } from "@/shared/http/api-route";
import { getPrepList } from "@/workflows/forecast-items/forecast-items";

const prepListQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  stationId: z.uuid().optional(),
});

/** Phase 25 policies 9-10 (D5): the prep list per station for one business date. Stores nothing. */
export const GET = apiRoute({ module: "kitchen", operation: "prep-list" }, async ({ request }) => {
  const actor = await requireApiActor();
  const query = parseWith(prepListQuerySchema, Object.fromEntries(new URL(request.url).searchParams.entries()));

  return { body: await getPrepList(getDatabase(), actor, { businessDate: query.date, stationId: query.stationId }) };
});
