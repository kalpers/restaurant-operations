import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { setUserActive } from "@/modules/auth/services/user-service";
import {
  setActiveSchema,
  userIdParamsSchema,
} from "@/modules/auth/validators/auth-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ userId: string }>(
  { module: "auth", operation: "set-user-active" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("admin.users.manage");
    const { userId } = parseWith(userIdParamsSchema, params);
    const input = await parseJsonBody(request, setActiveSchema);

    return {
      body: await setUserActive(getDatabase(), actor, { ...input, userId }),
    };
  },
);
