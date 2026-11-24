import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { setChecklistItem } from "@/modules/restaurant/services/checklist-service";
import { checklistItemIdParamsSchema, setChecklistItemSchema } from "@/modules/restaurant/validators/checklist-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 5): ticks, skips or reopens one item of a run. */
export const PATCH = apiRoute<{ itemId: string }>(
  { module: "restaurant", operation: "set-checklist-item" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(checklistItemIdParamsSchema, params);
    const body = await parseJsonBody(request, setChecklistItemSchema);

    return { body: await setChecklistItem(getDatabase(), actor, p.itemId, body) };
  },
);
