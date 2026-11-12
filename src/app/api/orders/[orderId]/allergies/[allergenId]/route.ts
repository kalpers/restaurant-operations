import { z } from "zod";

import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { removeOrderAllergy } from "@/modules/orders/services/order-allergy-service";
import { removeOrderAllergySchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

const paramsSchema = z.object({ orderId: z.uuid(), allergenId: z.uuid() });

/** Remove an allergy from a check with no guest party (Phase 21, policy 8). */
export const DELETE = apiRoute<{ orderId: string; allergenId: string }>(
  { module: "orders", operation: "remove-order-allergy" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { orderId, allergenId } = parseWith(paramsSchema, params);
    const body = await parseJsonBody(request, removeOrderAllergySchema);

    return { body: await removeOrderAllergy(getDatabase(), actor, { ...body, orderId, allergenId }) };
  },
);
