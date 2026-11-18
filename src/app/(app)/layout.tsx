import { cookies } from "next/headers";
import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell/app-shell";
import { LocationSwitcher } from "@/components/app-shell/location-switcher";
import { PageLocation } from "@/components/forms/page-location";
import {
  NAV_GROUPS_COOKIE,
  parseNavGroupsCookie,
  visibleNavigationGroups,
} from "@/components/app-shell/navigation";
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
  // Phase 27 (policy 6): read on the server so the first render shows the remembered groups.
  const navMemory = parseNavGroupsCookie((await cookies()).get(NAV_GROUPS_COOKIE)?.value);

  return (
    <LocationTimeZoneProvider timeZone={timeZone}>
    <RealtimeProvider locationId={location?.locationId ?? null}>
      <PageLocation locationId={location?.locationId ?? null} />
      <AppShell
        groups={groups}
        email={auth.email}
        initialNavMemory={navMemory}
        headerActions={
          <>
            {location && (
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
