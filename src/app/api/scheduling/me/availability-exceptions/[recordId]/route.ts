import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { removeAvailabilityException } from "@/modules/scheduling/services/availability-service";
import { expectedVersionSchema, ownRecordParamsSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const DELETE = apiRoute<{ recordId: string }>(
  { module: "scheduling", operation: "remove-own-exception" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(ownRecordParamsSchema, params);
    const body = await parseJsonBody(request, expectedVersionSchema);
    const db = getDatabase();

    await removeAvailabilityException(db, actor, { kind: "self" as const }, p.recordId, body);

    return {};
  },
);
