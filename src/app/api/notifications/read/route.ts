import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { markReadSchema } from "@/modules/kitchen/validators/kitchen-validators";
import { markNotificationsRead } from "@/modules/notifications/notification-service";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const POST = apiRoute({ module: "notifications", operation: "mark-read" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, markReadSchema);

  return { body: await markNotificationsRead(getDatabase(), actor, body) };
});
