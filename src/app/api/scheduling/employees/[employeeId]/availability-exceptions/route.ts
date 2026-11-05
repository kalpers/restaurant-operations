import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { addAvailabilityException } from "@/modules/scheduling/services/availability-service";
import { availabilityExceptionSchema, employeeIdParamsSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ employeeId: string }>(
  { module: "scheduling", operation: "add-availability-exception" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(employeeIdParamsSchema, params);
    const body = await parseJsonBody(request, availabilityExceptionSchema);
    const db = getDatabase();

    return { body: await addAvailabilityException(db, actor, { kind: "employee" as const, employeeId: p.employeeId }, body), status: 201 };
  },
);
