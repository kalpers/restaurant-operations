import type { Metadata } from "next";
import { headers } from "next/headers";

import { BookingForm } from "@/components/public/booking-form";
import { PublicShell } from "@/components/public/public-shell";
import { getDatabase } from "@/db";
import { findPublicLocation, listPublicAllergens } from "@/modules/reservations/services/online-booking-service";
import { addDays, localDateOf } from "@/shared/time/zoned-time";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Book a table" };

/** Phase 22 (policy 12): the public booking page. An unknown code and a closed one look the same. */
export default async function BookPage({ params }: { params: Promise<{ locationCode: string }> }) {
  const { locationCode } = await params;
  // Read so the page is rendered per request; throttling happens on the API calls it makes.
  await headers();

  const database = getDatabase();
  const location = await findPublicLocation(database, locationCode);

  if (!location) {
    return (
      <PublicShell title="Online booking isn't available">
        <p>Please contact the restaurant to book a table.</p>
      </PublicShell>
    );
  }

  const today = localDateOf(new Date(), location.timeZone);

  return (
    <PublicShell title={location.name} subtitle="Book a table">
      {location.settings.publicNote && <p className="mb-4 rounded-md bg-brand-50 p-3 text-sm">{location.settings.publicNote}</p>}
      <BookingForm
        code={location.code}
        today={today}
        lastDate={addDays(today, location.settings.maxDaysAhead)}
        maxPartySize={location.settings.maxPartySize}
        allergens={await listPublicAllergens(database, location.organizationId)}
      />
      {location.phone && <p className="mt-4 text-sm text-neutral-700">Questions? Call {location.phone}.</p>}
    </PublicShell>
  );
}
