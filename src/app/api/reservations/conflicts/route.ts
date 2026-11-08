import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { previewPlanningConflicts } from "@/modules/reservations/services/reservation-service";
import { conflictPreviewSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const POST = apiRoute(
  { module: "reservations", operation: "preview-conflicts" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const body = await parseJsonBody(request, conflictPreviewSchema);

    return { body: await previewPlanningConflicts(getDatabase(), actor, body) };
  },
);
