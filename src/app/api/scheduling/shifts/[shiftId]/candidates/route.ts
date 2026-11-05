import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listCandidates } from "@/modules/scheduling/services/schedule-service";
import { shiftIdParamsSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ shiftId: string }>(
  { module: "scheduling", operation: "list-candidates" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const p = parseWith(shiftIdParamsSchema, params);
    const db = getDatabase();

    return { body: { candidates: await listCandidates(db, actor, p.shiftId) } };
  },
);
