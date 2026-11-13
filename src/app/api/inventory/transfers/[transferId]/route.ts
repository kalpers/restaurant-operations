import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateDraftTransfer } from "@/modules/inventory/services/transfer-service";
import { transferDraftUpdateSchema, transferIdParamsSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 23: replaces a DRAFT's destination, notes and lines. */
export const PATCH = apiRoute<{ transferId: string }>(
  { module: "inventory", operation: "update-transfer" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { transferId } = parseWith(transferIdParamsSchema, params);
    const body = await parseJsonBody(request, transferDraftUpdateSchema);

    return { body: await updateDraftTransfer(getDatabase(), actor, transferId, body) };
  },
);
