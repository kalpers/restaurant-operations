import { eq } from "drizzle-orm";

import { onlineBookingPeriods, onlineBookingSettings } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";

/**
 * Phase 23 (policies 1–3): a new location's online booking, always off. With a source
 * location (D2 `BOOKING_HOURS`), its booking settings and hours are copied, still off.
 */
export async function createLocationOnlineBooking(
  transaction: DatabaseTransaction,
  input: { locationId: string; copyFromLocationId: string | null },
): Promise<void> {
  const [source] = input.copyFromLocationId
    ? await transaction
        .select()
        .from(onlineBookingSettings)
        .where(eq(onlineBookingSettings.locationId, input.copyFromLocationId))
    : [];

  if (!source) {
    await transaction.insert(onlineBookingSettings).values({ locationId: input.locationId, enabled: false });
  } else {
    await transaction.insert(onlineBookingSettings).values({
      locationId: input.locationId,
      enabled: false,
      requiresApproval: source.requiresApproval,
      maxPartySize: source.maxPartySize,
      minLeadMinutes: source.minLeadMinutes,
      maxDaysAhead: source.maxDaysAhead,
      slotIntervalMinutes: source.slotIntervalMinutes,
      maxCoversPerSlot: source.maxCoversPerSlot,
      reminderHoursBefore: source.reminderHoursBefore,
      publicNote: source.publicNote,
    });
  }

  if (input.copyFromLocationId) {
    const periods = await transaction
      .select({ weekday: onlineBookingPeriods.weekday, startsAt: onlineBookingPeriods.startsAt, endsAt: onlineBookingPeriods.endsAt })
      .from(onlineBookingPeriods)
      .where(eq(onlineBookingPeriods.locationId, input.copyFromLocationId));

    if (periods.length > 0) {
      await transaction
        .insert(onlineBookingPeriods)
        .values(periods.map((period) => ({ ...period, locationId: input.locationId })));
    }
  }
}

/** Phase 23 (policy 3): closing a location turns its online booking off. */
export async function turnOffOnlineBooking(transaction: DatabaseTransaction, locationId: string): Promise<void> {
  await transaction
    .update(onlineBookingSettings)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(onlineBookingSettings.locationId, locationId));
}
