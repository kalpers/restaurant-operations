import { z } from "zod";

import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { clearBundle } from "@/modules/menu/services/bundle-service";
import { clearBundleSchema } from "@/modules/menu/validators/bundle-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 9): makes a bundle an ordinary item again; its courses are deactivated. */
export const POST = apiRoute<{ itemId: string }>({ module: "menu", operation: "clear-bundle" }, async ({ request, params }) => {
  const actor = await requireApiActor();
  const p = parseWith(z.object({ itemId: z.uuid() }), params);
  const body = await parseJsonBody(request, clearBundleSchema);

  return { body: await clearBundle(getDatabase(), actor, p.itemId, body) };
});
