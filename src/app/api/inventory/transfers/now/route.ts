import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { transferNow } from "@/modules/inventory/services/transfer-service";
import { transferDraftSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Phase 23 (policy 13): "Send and receive now", with the permission at both locations. */
export const POST = apiRoute({ module: "inventory", operation: "transfer-now" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, transferDraftSchema);

  return { body: await transferNow(getDatabase(), actor, body), status: 201 };
});
