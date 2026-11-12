import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { resendTableReady } from "@/modules/reservations/services/guest-message-service";
import { entryIdParamsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Send the table-ready message again for a notified entry (Phase 22, amendment 7). */
export const POST = apiRoute<{ entryId: string }>(
  { module: "reservations", operation: "resend-table-ready" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const { entryId } = parseWith(entryIdParamsSchema, params);

    return { body: await resendTableReady(getDatabase(), actor, entryId) };
  },
);
