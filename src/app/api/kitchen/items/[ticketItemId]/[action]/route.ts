import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { transitionTicketItem } from "@/modules/kitchen/services/fulfillment-service";
import {
  ticketItemActionParamsSchema,
  transitionSchema,
} from "@/modules/kitchen/validators/kitchen-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Start, ready or complete (bump) one station item: exactly one transition per action. */
export const POST = apiRoute<{ ticketItemId: string; action: string }>(
  { module: "kitchen", operation: "transition-item" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(ticketItemActionParamsSchema, params);
    const body = await parseJsonBody(request, transitionSchema);

    return { body: await transitionTicketItem(getDatabase(), actor, p.ticketItemId, p.action, body) };
  },
);
