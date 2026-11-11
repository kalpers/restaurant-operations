import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listAdjustments } from "@/modules/scheduling/services/timeclock-service";
import { entryIdParamsSchema } from "@/modules/scheduling/validators/timeclock-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** An entry's adjustment history. */
export const GET = apiRoute<{ entryId: string }>(
  { module: "scheduling", operation: "list-time-entry-adjustments" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const p = parseWith(entryIdParamsSchema, params);

    return { body: await listAdjustments(getDatabase(), actor, p.entryId) };
  },
);
