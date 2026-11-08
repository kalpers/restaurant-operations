import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { assignWaitlistTables } from "@/modules/reservations/services/waitlist-service";
import { waitlistTablesSchema, entryIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ entryId: string }>(
  { module: "waitlist", operation: "assign-waitlist-tables" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(entryIdParamsSchema, params);
    const body = await parseJsonBody(request, waitlistTablesSchema);

    return { body: await assignWaitlistTables(getDatabase(), actor, p.entryId, body) };
  },
);
