import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { cancelTransfer } from "@/modules/inventory/services/transfer-service";
import { transferIdParamsSchema, versionSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 23: cancels a DRAFT. */
export const POST = apiRoute<{ transferId: string }>(
  { module: "inventory", operation: "cancel-transfer" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { transferId } = parseWith(transferIdParamsSchema, params);
    const { expectedVersion } = await parseJsonBody(request, versionSchema);

    return { body: await cancelTransfer(getDatabase(), actor, transferId, expectedVersion) };
  },
);
