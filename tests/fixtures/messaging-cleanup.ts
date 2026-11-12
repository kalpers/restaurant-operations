import { inArray, sql } from "drizzle-orm";

import type { Database } from "@/db";
import {
  guestMessages,
  guestPartyMessageConsents,
  messageSuppressions,
  onlineBookingPeriods,
  onlineBookingSettings,
  publicThrottles,
  reservationManageLinks,
  reservations,
} from "@/db/schema";

const GUARDED = [
  ["guest_messages", "guest_messages_guard"],
  ["message_suppressions", "message_suppressions_guard"],
  ["guest_party_message_consents", "guest_party_message_consents_guard"],
  ["reservation_manage_links", "reservation_manage_links_guard"],
] as const;

/**
 * Phase 22: guest messages, consents, manage links and the opt-out list. Each is guarded
 * against deletes, so the guards are lifted for this transaction only (test database). Runs
 * before reservations, waitlist entries and guest parties are removed.
 */
export async function clearGuestMessagingData(database: Database): Promise<void> {
  await database.transaction(async (transaction) => {
    for (const [table, trigger] of GUARDED) {
      await transaction.execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`));
    }

    await transaction.delete(guestMessages);
    await transaction.delete(messageSuppressions);
    await transaction.delete(guestPartyMessageConsents);
    await transaction.delete(reservationManageLinks);
    // Online booking configuration references users, and throttles would carry over.
    await transaction.delete(onlineBookingPeriods);
    await transaction.delete(onlineBookingSettings);
    await transaction.delete(publicThrottles);

    for (const [table, trigger] of GUARDED) {
      await transaction.execute(sql.raw(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`));
    }
  });
}

/** Phase 22: the messaging rows of some guest parties only (E2E cleanup by guest name). */
export async function clearGuestMessagingForParties(database: Database, partyIds: readonly string[]): Promise<void> {
  if (partyIds.length === 0) {
    return;
  }

  await database.transaction(async (transaction) => {
    for (const [table, trigger] of GUARDED) {
      await transaction.execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`));
    }

    await transaction.delete(guestMessages).where(inArray(guestMessages.guestPartyId, [...partyIds]));
    await transaction.delete(guestPartyMessageConsents).where(inArray(guestPartyMessageConsents.guestPartyId, [...partyIds]));
    await transaction
      .delete(reservationManageLinks)
      .where(
        inArray(
          reservationManageLinks.reservationId,
          transaction.select({ id: reservations.id }).from(reservations).where(inArray(reservations.guestPartyId, [...partyIds])),
        ),
      );

    for (const [table, trigger] of GUARDED) {
      await transaction.execute(sql.raw(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`));
    }
  });
}
