import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getExpoView } from "@/modules/kitchen/queries/kitchen-queries";
import { apiRoute } from "@/shared/http/api-route";

export const GET = apiRoute({ module: "kitchen", operation: "expo" }, async () => {
  const actor = await requireApiActor();

  return { body: await getExpoView(getDatabase(), actor) };
});
