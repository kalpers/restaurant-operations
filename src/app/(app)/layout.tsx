import Link from "next/link";
import type { ReactNode } from "react";

import { LocationSwitcher } from "@/components/app-shell/location-switcher";
import { visibleNavigation } from "@/components/app-shell/navigation";
import { SignOutButton } from "@/components/app-shell/sign-out-button";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { RealtimeProvider } from "@/components/realtime/realtime-provider";
import { requirePageUser, resolveCurrentLocation } from "@/modules/auth/guards";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const auth = await requirePageUser();
  const location = await resolveCurrentLocation(auth);
  const navigation = visibleNavigation(location?.permissions ?? []);

  return (
    <RealtimeProvider>
      <div className="min-h-screen">
        <header className="border-b border-neutral-200">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <p className="font-semibold">Restaurant Operations</p>
            <div className="flex flex-wrap items-center gap-3">
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
              <span className="text-sm break-all text-neutral-600">{auth.email}</span>
              <SignOutButton />
            </div>
          </div>
          <nav aria-label="Main" className="mx-auto max-w-6xl px-2 pb-2">
            <ul className="flex flex-wrap">
              {navigation.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="flex min-h-11 items-center rounded px-3 text-sm font-medium hover:bg-neutral-100"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </div>
    </RealtimeProvider>
  );
}
