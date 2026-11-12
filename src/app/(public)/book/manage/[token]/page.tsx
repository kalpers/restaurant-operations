import type { Metadata } from "next";
import { headers } from "next/headers";

import { GuestCancelButton } from "@/components/public/guest-cancel-button";
import { PublicShell } from "@/components/public/public-shell";
import { getDatabase } from "@/db";
import { publicContextFromHeaders } from "@/modules/reservations/public-request";
import { getManagedReservation } from "@/modules/reservations/services/online-booking-service";
import { TooManyRequestsError } from "@/shared/errors/app-error";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Your booking", robots: { index: false, follow: false } };

/** Phase 22 (policy 11): view or cancel a booking through its private link. */
export default async function ManageBookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let view;

  try {
    view = await getManagedReservation(getDatabase(), token, publicContextFromHeaders(await headers()));
  } catch (error) {
    if (error instanceof TooManyRequestsError) {
      return (
        <PublicShell title="Please wait">
          <p>{error.message}</p>
        </PublicShell>
      );
    }

    throw error;
  }

  if (!view) {
    return (
      <PublicShell title="This link isn't valid">
        <p>It may have expired, or the booking may have changed. Please contact the restaurant.</p>
      </PublicShell>
    );
  }

  const statusText =
    view.status === "CONFIRMED"
      ? "Confirmed"
      : view.status === "PENDING"
        ? "Waiting for the restaurant to confirm"
        : view.status === "CANCELLED"
          ? "Cancelled"
          : "In progress";

  return (
    <PublicShell title={view.locationName} subtitle="Your booking">
      <dl className="mb-4 grid gap-2 sm:grid-cols-[auto_1fr] sm:gap-x-4">
        <dt className="text-sm text-neutral-700">When</dt>
        <dd className="font-medium">{view.when}</dd>
        <dt className="text-sm text-neutral-700">Guests</dt>
        <dd className="font-medium">{view.partySize}</dd>
        <dt className="text-sm text-neutral-700">Status</dt>
        <dd className="font-medium" data-testid="booking-status">
          {statusText}
        </dd>
        <dt className="text-sm text-neutral-700">Reference</dt>
        <dd className="font-medium">{view.reference}</dd>
      </dl>
      {view.canCancel ? (
        <GuestCancelButton token={token} />
      ) : (
        view.status !== "CANCELLED" && (
          <p className="text-sm">To change this booking, please call{view.locationPhone ? ` ${view.locationPhone}` : " the restaurant"}.</p>
        )
      )}
      {view.canCancel && (
        <p className="mt-3 text-sm text-neutral-700">
          To change the time or party size, cancel and book again{view.locationPhone ? `, or call ${view.locationPhone}` : ""}.
        </p>
      )}
    </PublicShell>
  );
}
