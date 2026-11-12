import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { EntityForm } from "@/components/forms/entity-form";
import { MergeProfileForm } from "@/components/reservations/merge-profile-form";
import { ProfileAllergiesForm } from "@/components/reservations/profile-allergies-form";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Breadcrumbs } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listAllergens } from "@/modules/recipes/queries/allergen-facts";
import { getGuestVisits } from "@/modules/reservations/queries/guest-visits";
import { actorHolds } from "@/modules/reservations/services/guest-access";
import { getGuestProfile } from "@/modules/reservations/services/guest-profile-service";
import { NotFoundError } from "@/shared/errors/app-error";
import { formatInstant } from "@/shared/time/format-instant";

const STATUS_LABELS: Record<string, string> = {
  EXPECTED: "Expected",
  WAITING: "Waiting",
  CHECKED_IN: "Checked in",
  SEATED: "Seated",
  COMPLETED: "Visited",
  CANCELLED: "Cancelled",
  NO_SHOW: "No-show",
};

/** Phase 21 (policies 1-5, 16): one guest's profile, allergies and visits. */
export default async function GuestProfilePage({ params }: { params: Promise<{ profileId: string }> }) {
  const { actor } = await requirePageActor("guests.view");
  const parsed = z.uuid().safeParse((await params).profileId);

  if (!parsed.success) {
    notFound();
  }

  const database = getDatabase();
  const profile = await getGuestProfile(database, actor, parsed.data).catch((error) => {
    if (error instanceof NotFoundError) {
      notFound();
    }

    throw error;
  });
  const [{ summary, visits }, allergens] = await Promise.all([
    getGuestVisits(database, actor, profile.id),
    listAllergens(database, actor.organizationId),
  ]);
  const active = profile.status === "ACTIVE";
  const canManage = active && actorHolds(actor, "guests.manage");
  const canSeeContact = actorHolds(actor, "guests.contact.view");

  return (
    <>
      <Breadcrumbs items={[{ label: "Guests", href: "/host/guests" }, { label: profile.displayName }]} />
      <h1 className="mb-1 flex flex-wrap items-center gap-2 text-2xl font-semibold">
        {profile.displayName}
        {profile.vip && <Badge tone="brand">VIP</Badge>}
        {!active && <Badge>{profile.status === "MERGED" ? "Merged" : "Erased"}</Badge>}
      </h1>
      <p className="mb-6 text-neutral-600">
        Profile #{profile.profileNumber}
        {profile.vipReason ? ` · ${profile.vipReason}` : ""}
      </p>

      {profile.status === "MERGED" && profile.mergedIntoProfileId && (
        <p role="status" className="mb-6 rounded border border-neutral-300 bg-neutral-100 p-3">
          This profile was merged.{" "}
          <Link href={`/host/guests/${profile.mergedIntoProfileId}`} className="underline">
            Open the profile it was merged into
          </Link>
          .
        </p>
      )}

      <section aria-label="Visit summary" className="mb-8 grid gap-2 rounded-lg border border-neutral-200 bg-surface p-4 shadow-sm sm:grid-cols-4">
        <p>
          <span className="block text-sm text-neutral-600">Visits</span>
          <span className="text-xl font-semibold">{summary.seatedVisits}</span>
        </p>
        <p>
          <span className="block text-sm text-neutral-600">Last visit</span>
          <span className="text-xl font-semibold">
            {summary.lastVisitAt ? formatInstant(summary.lastVisitAt, visits[0]?.timeZone ?? "UTC", "date") : "—"}
          </span>
        </p>
        <p>
          <span className="block text-sm text-neutral-600">No-shows / cancellations</span>
          <span className="text-xl font-semibold">
            {summary.noShows} / {summary.cancellations}
          </span>
        </p>
        <p>
          <span className="block text-sm text-neutral-600">Average spend</span>
          <span className="text-xl font-semibold">{summary.averageSpend ? `$${summary.averageSpend}` : "—"}</span>
        </p>
      </section>

      <section aria-label="Allergies" className="mb-8 rounded-lg border border-neutral-200 bg-surface p-4 shadow-sm">
        <h2 className="mb-1 text-xl font-semibold">Allergies</h2>
        <p className="mb-3 text-sm text-neutral-600">
          Copied onto each visit linked to this profile. Servers are warned when an item matches.
        </p>
        {canManage ? (
          <ProfileAllergiesForm
            profileId={profile.id}
            version={profile.version}
            allergens={allergens.map(({ id, name, active: on }) => ({ id, name, active: on }))}
            current={profile.allergies}
          />
        ) : profile.allergies.length === 0 ? (
          <p className="text-sm">None recorded.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {profile.allergies.map((entry) => (
              <li key={entry.allergenId}>
                <Badge tone={entry.severity === "SEVERE" ? "danger" : "warning"}>
                  {entry.name}
                  {entry.severity === "SEVERE" ? " · severe" : ""}
                </Badge>
                {entry.note && <span className="ml-1 text-xs text-neutral-700">{entry.note}</span>}
              </li>
            ))}
          </ul>
        )}
        {profile.otherDietaryNeeds && (
          <p className="mt-3 text-sm">
            Other dietary needs (not checked against the menu): {profile.otherDietaryNeeds}
          </p>
        )}
      </section>

      {canManage ? (
        <section aria-label="Details" className="mb-8 rounded-lg border border-neutral-200 bg-surface p-4 shadow-sm">
          <h2 className="mb-3 text-xl font-semibold">Details</h2>
          <EntityForm
            method="PATCH"
            url={`/api/guests/${profile.id}`}
            submitLabel="Save profile"
            hidden={{ expectedVersion: profile.version }}
            fields={[
              { name: "displayName", label: "Name", required: true, defaultValue: profile.displayName },
              ...(canSeeContact
                ? [
                    { name: "phone", label: "Phone", defaultValue: profile.phone ?? null },
                    { name: "email", label: "Email", type: "email" as const, defaultValue: profile.email ?? null },
                  ]
                : []),
              { name: "vip", label: "VIP", type: "checkbox", defaultValue: profile.vip },
              { name: "vipReason", label: "VIP reason", defaultValue: profile.vipReason },
              { name: "preferences", label: "Preferences", type: "textarea", defaultValue: profile.preferences },
              { name: "notes", label: "Notes", type: "textarea", defaultValue: profile.notes },
              { name: "otherDietaryNeeds", label: "Other dietary needs", type: "textarea", defaultValue: profile.otherDietaryNeeds },
            ]}
          />
        </section>
      ) : (
        <section aria-label="Details" className="mb-8 rounded-lg border border-neutral-200 bg-surface p-4 shadow-sm">
          <h2 className="mb-3 text-xl font-semibold">Details</h2>
          {canSeeContact && (
            <p className="text-sm">
              {profile.phone ?? "No phone"} · {profile.email ?? "No email"}
            </p>
          )}
          {profile.preferences && <p className="text-sm">Preferences: {profile.preferences}</p>}
          {profile.notes && <p className="text-sm">Notes: {profile.notes}</p>}
        </section>
      )}

      <section aria-label="Visits" className="mb-8 rounded-lg border border-neutral-200 bg-surface p-4 shadow-sm">
        <h2 className="mb-3 text-xl font-semibold">Visits</h2>
        {visits.length === 0 ? (
          <EmptyState title="No visits linked yet." />
        ) : (
          <ul className="grid gap-3">
            {visits.map((visit) => (
              <li key={visit.guestPartyId} className="rounded border border-neutral-200 p-3">
                <p className="font-medium">
                  {formatInstant(visit.at, visit.timeZone)} · {visit.locationName} · party of {visit.partySize} ·{" "}
                  {STATUS_LABELS[visit.status] ?? visit.status}
                </p>
                {visit.checks.map((check) => (
                  <p key={check.orderId} className="text-sm text-neutral-700">
                    Check #{check.orderNumber} ({check.status.toLowerCase()}) · ${check.totalDue}
                    {check.items.length > 0 ? ` · ${check.items.join(", ")}` : ""}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>

      {active && actorHolds(actor, "guests.merge") && (
        <section aria-label="Merge into another profile" className="mb-8 rounded-lg border border-neutral-200 bg-surface p-4 shadow-sm">
          <h2 className="mb-1 text-xl font-semibold">Merge into another profile</h2>
          <p className="mb-3 text-sm text-neutral-600">
            When this is a duplicate: its visits and allergies move to the profile kept, and this one is closed.
            A merge can&apos;t be undone. Find the profile to keep.
          </p>
          <MergeProfileForm profileId={profile.id} version={profile.version} />
        </section>
      )}

      {active && actorHolds(actor, "guests.erase") && (
        <section aria-label="Erase this guest" className="mb-8 rounded-lg border border-danger-300 bg-danger-50 p-4">
          <h2 className="mb-1 text-xl font-semibold">Erase this guest</h2>
          <p className="mb-3 text-sm">
            Clears the name, contact details, notes and allergies from this profile, any profile merged into it,
            and its past visits. Orders and reports stay. This can&apos;t be undone. Don&apos;t put the guest&apos;s
            name in the reason.
          </p>
          <EntityForm
            method="POST"
            url={`/api/guests/${profile.id}/erase`}
            submitLabel="Erase personal data"
            successMessage="Erased."
            hidden={{ expectedVersion: profile.version }}
            fields={[{ name: "reason", label: "Reason", required: true }]}
          />
        </section>
      )}

    </>
  );
}
