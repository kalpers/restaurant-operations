import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { resetUserPassword } from "@/modules/auth/services/password-service";
import { resetPasswordSchema, userIdParamsSchema } from "@/modules/auth/validators/auth-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/**
 * An administrator's password reset. The temporary password is in this response only: it is
 * never logged, audited or stored except as a hash.
 */
export const POST = apiRoute<{ userId: string }>(
  { module: "auth", operation: "reset-user-password" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("admin.users.manage");
    const { userId } = parseWith(userIdParamsSchema, params);
    const input = await parseJsonBody(request, resetPasswordSchema);
    const result = await resetUserPassword(getDatabase(), actor, { ...input, userId });

    return {
      response: Response.json(result, { headers: { "Cache-Control": "no-store" } }),
    };
  },
);
