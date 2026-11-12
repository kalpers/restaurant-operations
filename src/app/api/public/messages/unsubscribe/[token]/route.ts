import { getDatabase } from "@/db";
import { unsubscribeByToken } from "@/modules/reservations/services/guest-message-service";
import { apiRoute } from "@/shared/http/api-route";

/** Public, signed out (Phase 22, policy 4): one-click email opt-out. Same answer for any token. */
export const POST = apiRoute<{ token: string }>(
  { module: "reservations", operation: "public-unsubscribe" },
  async ({ params }) => ({ body: await unsubscribeByToken(getDatabase(), params.token) }),
);
