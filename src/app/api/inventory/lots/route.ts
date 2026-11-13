import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listLots } from "@/modules/inventory/services/lot-service";
import { apiRoute } from "@/shared/http/api-route";

/** Phase 23 (policy 22): lots with stock here, first to expire first, with their status. */
export const GET = apiRoute({ module: "inventory", operation: "list-lots" }, async () => {
  const actor = await requireApiActor();

  return { body: await listLots(getDatabase(), actor) };
});
