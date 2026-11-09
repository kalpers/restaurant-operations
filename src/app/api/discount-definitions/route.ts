import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import {
  createDiscountDefinition,
  listDiscountDefinitions,
} from "@/modules/orders/services/discount-service";
import { createDiscountDefinitionSchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute({ module: "orders", operation: "list-discounts" }, async ({ request }) => {
  const actor = await requireApiActor();
  const includeInactive = new URL(request.url).searchParams.get("includeInactive") === "true";

  return { body: await listDiscountDefinitions(getDatabase(), actor, { includeInactive }) };
});

export const POST = apiRoute({ module: "orders", operation: "create-discount" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, createDiscountDefinitionSchema);

  return { body: await createDiscountDefinition(getDatabase(), actor, body), status: 201 };
});
