import { z } from "zod";

import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { retryDeadLetteredEvent } from "@/modules/auth/services/system-health-service";
import { apiRoute, parseWith } from "@/shared/http/api-route";

const paramsSchema = z.object({ eventId: z.uuid() });

export const POST = apiRoute<{ eventId: string }>(
  { module: "auth", operation: "retry-outbox-event" },
  async ({ params }) => {
    const actor = await requireApiPermission("admin.system.manage");
    const { eventId } = parseWith(paramsSchema, params);

    return { body: await retryDeadLetteredEvent(getDatabase(), actor, eventId) };
  },
);
