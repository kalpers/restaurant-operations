import { cookies } from "next/headers";

import { getAuthConfig } from "@/config/auth-env";
import {
  CURRENT_LOCATION_COOKIE,
  requireCurrentUser,
} from "@/modules/auth/guards";
import { selectLocationSchema } from "@/modules/auth/validators/auth-validators";
import { AuthorizationError } from "@/shared/errors/app-error";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const PUT = apiRoute(
  { module: "auth", operation: "select-location" },
  async ({ request }) => {
    const auth = await requireCurrentUser();
    const { locationId } = await parseJsonBody(request, selectLocationSchema);

    if (!auth.locations.some((location) => location.locationId === locationId)) {
      throw new AuthorizationError();
    }

    (await cookies()).set(CURRENT_LOCATION_COOKIE, locationId, {
      httpOnly: true,
      sameSite: "lax",
      secure: getAuthConfig().secureCookies,
      path: "/",
    });

    return {};
  },
);
