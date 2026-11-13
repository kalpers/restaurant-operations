import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { sendTransfer } from "@/modules/inventory/services/transfer-service";
import { transferIdParamsSchema, transferSendSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 23 (policy 11): sends a DRAFT. Retrying with the same key repeats nothing. */
export const POST = apiRoute<{ transferId: string }>(
  { module: "inventory", operation: "send-transfer" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { transferId } = parseWith(transferIdParamsSchema, params);
    const body = await parseJsonBody(request, transferSendSchema);

    return { body: await sendTransfer(getDatabase(), actor, transferId, body) };
  },
);
