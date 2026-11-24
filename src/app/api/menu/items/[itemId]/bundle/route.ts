import { z } from "zod";

import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getBundleConfiguration, saveBundleConfiguration } from "@/modules/menu/services/bundle-service";
import { saveBundleSchema } from "@/modules/menu/validators/bundle-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

const paramsSchema = z.object({ itemId: z.uuid() });

/** Phase 36 (policy 9): a bundle's courses and choices. */
export const GET = apiRoute<{ itemId: string }>({ module: "menu", operation: "get-bundle" }, async ({ params }) => {
  const actor = await requireApiActor();
  const p = parseWith(paramsSchema, params);

  return { body: await getBundleConfiguration(getDatabase(), actor, p.itemId) };
});

/** Makes the item a bundle, or updates its courses and choices. */
export const PUT = apiRoute<{ itemId: string }>({ module: "menu", operation: "save-bundle" }, async ({ request, params }) => {
  const actor = await requireApiActor();
  const p = parseWith(paramsSchema, params);
  const body = await parseJsonBody(request, saveBundleSchema);

  return { body: await saveBundleConfiguration(getDatabase(), actor, p.itemId, body) };
});
