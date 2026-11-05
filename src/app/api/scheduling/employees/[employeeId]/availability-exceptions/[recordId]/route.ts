import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { removeAvailabilityException } from "@/modules/scheduling/services/availability-service";
import { expectedVersionSchema, recordParamsSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const DELETE = apiRoute<{ employeeId: string; recordId: string }>(
  { module: "scheduling", operation: "remove-availability-exception" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(recordParamsSchema, params);
    const body = await parseJsonBody(request, expectedVersionSchema);
    const db = getDatabase();

    await removeAvailabilityException(db, actor, { kind: "employee" as const, employeeId: p.employeeId }, p.recordId, body);

    return {};
  },
);
