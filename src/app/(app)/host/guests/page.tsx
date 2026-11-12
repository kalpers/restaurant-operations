import Link from "next/link";

import { EntityForm } from "@/components/forms/entity-form";
import { HostTabs } from "@/components/reservations/host-tabs";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { INPUT_STYLE } from "@/components/ui/field";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { searchGuestProfiles } from "@/modules/reservations/services/guest-profile-service";
import { actorHolds } from "@/modules/reservations/services/guest-access";

/** Phase 21 (policy 16): find and add guest profiles. */
export default async function GuestsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { location, actor } = await requirePageActor("guests.view");
  const query = ((await searchParams).q ?? "").slice(0, 120);
  const results = query.trim() ? await searchGuestProfiles(getDatabase(), actor, query) : [];
  const canManage = actorHolds(actor, "guests.manage");
  const canSeeContact = actorHolds(actor, "guests.contact.view");

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Guests</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>
      <HostTabs
        active="guests"
        abilities={{
          floor: actorHolds(actor, "restaurant.view"),
          reservations: actorHolds(actor, "reservations.view"),
          waitlist: actorHolds(actor, "waitlist.view"),
          guests: true,
        }}
      />

      <form method="get" role="search" aria-label="Find a guest" className="mb-6 flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm font-medium">
          {canSeeContact ? "Name, phone or email" : "Name"}
          <input type="search" name="q" defaultValue={query} className={INPUT_STYLE} />
        </label>
        <button type="submit" className="min-h-11 rounded border border-neutral-400 px-4 text-sm font-medium">
          Search
        </button>
      </form>

      {query.trim() && (
        <section aria-label="Search results" className="mb-8">
          {results.length === 0 ? (
            <EmptyState title="No matching guests." />
          ) : (
            <ul className="grid gap-2">
              {results.map((guest) => (
                <li key={guest.id} className="flex flex-wrap items-center gap-2 rounded border border-neutral-200 bg-surface p-3">
                  <Link href={`/host/guests/${guest.id}`} className="font-medium underline">
                    {guest.displayName}
                  </Link>
                  <span className="text-sm text-neutral-500">#{guest.profileNumber}</span>
                  {guest.vip && <Badge tone="brand">VIP</Badge>}
                  {guest.allergies.map((allergy) => (
                    <Badge key={allergy.allergenId} tone={allergy.severity === "SEVERE" ? "danger" : "warning"}>
                      {allergy.name}
                    </Badge>
                  ))}
                  {guest.phone && <span className="text-sm text-neutral-600">{guest.phone}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {canManage && (
        <section aria-label="New guest profile" className="mb-8 rounded-lg border border-neutral-200 bg-surface p-4 shadow-sm">
          <h2 className="mb-1 text-xl font-semibold">New guest profile</h2>
          <p className="mb-3 text-sm text-neutral-600">
            Search first, so the same guest doesn&apos;t get two profiles. Don&apos;t record payment details anywhere here.
          </p>
          <EntityForm
            method="POST"
            url="/api/guests"
            submitLabel="Create profile"
            resetOnSuccess
            successMessage="Profile created."
            fields={[
              { name: "displayName", label: "Name", required: true },
              { name: "phone", label: "Phone" },
              { name: "email", label: "Email", type: "email" },
              { name: "vip", label: "VIP", type: "checkbox" },
              { name: "preferences", label: "Preferences (seating, drinks)", type: "textarea" },
            ]}
          />
        </section>
      )}
    </>
  );
}
