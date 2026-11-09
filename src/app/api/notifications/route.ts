import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listNotifications } from "@/modules/notifications/notification-service";
import { apiRoute } from "@/shared/http/api-route";

export const GET = apiRoute({ module: "notifications", operation: "list" }, async () => {
  const actor = await requireApiActor();

  return { body: await listNotifications(getDatabase(), actor) };
});
