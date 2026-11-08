import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listTableHoldIndicators } from "@/modules/reservations/services/hold-service";
import { apiRoute } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "reservations", operation: "list-table-holds" },
  async () => {
    const actor = await requireApiActor();

    return { body: { holds: await listTableHoldIndicators(getDatabase(), actor) } };
  },
);
