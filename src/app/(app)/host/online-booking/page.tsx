import { HostTabs } from "@/components/reservations/host-tabs";
import { OnlineBookingSettingsForm } from "@/components/reservations/online-booking-settings-form";
import { getMessagingConfig } from "@/config/messaging-env";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { getOnlineBookingSettings } from "@/modules/reservations/services/online-booking-service";
import { actorHolds } from "@/modules/restaurant/services/access";

/** Phase 22 (policy 7): online booking settings and booking hours. */
export default async function OnlineBookingPage() {
  const { location, actor } = await requirePageActor("reservations.online.manage");
  const database = getDatabase();
  const settings = await getOnlineBookingSettings(database, actor);
  const bookingUrl = `${getMessagingConfig().appBaseUrl}/book/${location.locationCode.toLowerCase()}`;

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Online booking</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>
      <HostTabs
        active="online"
        abilities={{
          floor: actorHolds(actor, "restaurant.view"),
          reservations: actorHolds(actor, "reservations.view"),
          waitlist: actorHolds(actor, "waitlist.view"),
          guests: actorHolds(actor, "guests.view"),
          online: true,
        }}
      />
      <OnlineBookingSettingsForm settings={settings} bookingUrl={bookingUrl} />
    </>
  );
}
