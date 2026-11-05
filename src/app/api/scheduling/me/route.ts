import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getMySchedule } from "@/modules/scheduling/services/my-schedule-service";
import { apiRoute } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "scheduling", operation: "get-my-schedule" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await getMySchedule(db, actor) };
  },
);
