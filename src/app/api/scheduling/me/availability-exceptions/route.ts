import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { addAvailabilityException } from "@/modules/scheduling/services/availability-service";
import { availabilityExceptionSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const POST = apiRoute(
  { module: "scheduling", operation: "add-own-exception" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const body = await parseJsonBody(request, availabilityExceptionSchema);
    const db = getDatabase();

    return { body: await addAvailabilityException(db, actor, { kind: "self" as const }, body), status: 201 };
  },
);
