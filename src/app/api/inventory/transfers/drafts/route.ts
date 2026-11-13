import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createTransfer, listTransfers } from "@/modules/inventory/services/transfer-service";
import { transferDraftSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Phase 23: transfers from or to the current location. */
export const GET = apiRoute({ module: "inventory", operation: "list-transfers" }, async () => {
  const actor = await requireApiActor();

  return { body: { transfers: await listTransfers(getDatabase(), actor) } };
});

/** Phase 23 (policy 10): a DRAFT transfer from the current location. */
export const POST = apiRoute({ module: "inventory", operation: "create-transfer" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, transferDraftSchema);

  return { body: await createTransfer(getDatabase(), actor, body), status: 201 };
});
