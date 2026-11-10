import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { unlockUser } from "@/modules/auth/services/user-service";
import { userIdParamsSchema } from "@/modules/auth/validators/auth-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ userId: string }>(
  { module: "auth", operation: "unlock-user" },
  async ({ params }) => {
    const actor = await requireApiPermission("admin.users.manage");
    const { userId } = parseWith(userIdParamsSchema, params);

    return { body: await unlockUser(getDatabase(), actor, { userId }) };
  },
);
