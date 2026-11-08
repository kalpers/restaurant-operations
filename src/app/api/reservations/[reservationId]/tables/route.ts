import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { setPlannedTables } from "@/modules/reservations/services/reservation-service";
import { plannedTablesSchema, reservationIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ reservationId: string }>(
  { module: "reservations", operation: "plan-reservation-tables" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(reservationIdParamsSchema, params);
    const body = await parseJsonBody(request, plannedTablesSchema);

    return { body: await setPlannedTables(getDatabase(), actor, p.reservationId, body) };
  },
);
