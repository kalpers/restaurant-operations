import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { savePreferences } from "@/modules/scheduling/services/availability-service";
import { employeeIdParamsSchema, preferencesSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PUT = apiRoute<{ employeeId: string }>(
  { module: "scheduling", operation: "save-preferences" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(employeeIdParamsSchema, params);
    const body = await parseJsonBody(request, preferencesSchema);
    const db = getDatabase();

    return { body: await savePreferences(db, actor, { kind: "employee" as const, employeeId: p.employeeId }, body) };
  },
);
