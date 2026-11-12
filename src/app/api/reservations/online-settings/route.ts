import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import {
  getOnlineBookingSettings,
  saveOnlineBookingSettings,
} from "@/modules/reservations/services/online-booking-service";
import { onlineBookingSettingsSchema } from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Online booking settings (Phase 22, policy 7). */
export const GET = apiRoute({ module: "reservations", operation: "get-online-settings" }, async () => {
  const actor = await requireApiActor();

  return { body: await getOnlineBookingSettings(getDatabase(), actor) };
});

export const PUT = apiRoute({ module: "reservations", operation: "save-online-settings" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, onlineBookingSettingsSchema);

  return { body: await saveOnlineBookingSettings(getDatabase(), actor, body) };
});
