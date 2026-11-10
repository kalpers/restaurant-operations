import { getDatabase } from "@/db";
import { requireCurrentUserAllowingPasswordChange } from "@/modules/auth/guards";
import { changeOwnPassword } from "@/modules/auth/services/password-service";
import { freshSessionCookie } from "@/modules/auth/session-cookie";
import { changePasswordSchema } from "@/modules/auth/validators/auth-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/**
 * Self-service password change. Needs no permission: users change only their own. Reachable
 * while a forced change is pending. Ends every older session and issues a fresh one.
 */
export const POST = apiRoute({ module: "auth", operation: "change-password" }, async ({ request }) => {
  const auth = await requireCurrentUserAllowingPasswordChange();
  const input = await parseJsonBody(request, changePasswordSchema);
  const result = await changeOwnPassword(getDatabase(), auth.userId, input);
  const cookie = await freshSessionCookie(auth.userId, result.passwordChangedAt.getTime());

  return {
    response: Response.json({ changed: true }, { headers: { "Set-Cookie": cookie } }),
  };
});
