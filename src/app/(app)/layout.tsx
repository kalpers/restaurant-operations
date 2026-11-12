import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell/app-shell";
import { LocationSwitcher } from "@/components/app-shell/location-switcher";
import { visibleNavigationGroups } from "@/components/app-shell/navigation";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { RealtimeProvider } from "@/components/realtime/realtime-provider";
import { LocationTimeZoneProvider } from "@/components/time/location-time-zone";
import { getDatabase } from "@/db";
import { requirePageUser, resolveCurrentLocation } from "@/modules/auth/guards";
import { getLocationTimeZone } from "@/modules/organization/services/organization-service";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const auth = await requirePageUser();
  const location = await resolveCurrentLocation(auth);
  const groups = visibleNavigationGroups(location?.permissions ?? []);
  const timeZone = location ? await getLocationTimeZone(getDatabase(), location.locationId) : "UTC";

  return (
    <LocationTimeZoneProvider timeZone={timeZone}>
    <RealtimeProvider>
      <AppShell
        groups={groups}
        email={auth.email}
        headerActions={
          <>
            {location && auth.locations.length > 1 && (
              <LocationSwitcher
                currentLocationId={location.locationId}
                locations={auth.locations.map((candidate) => ({
                  id: candidate.locationId,
                  name: candidate.locationName,
                }))}
              />
            )}
            {location && <NotificationBell />}
          </>
        }
      >
        {children}
      </AppShell>
    </RealtimeProvider>
    </LocationTimeZoneProvider>
  );
}
