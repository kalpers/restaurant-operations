import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import type { Actor } from "@/modules/auth/types";

// Phase 27 (policies 2–3): the waitlist's outbox events, written in the transaction that makes
// the change and delivered after commit. Identifiers only: never the guest's name or contact.

export type WaitlistEventType =
  | "waitlist.entry-added"
  | "waitlist.entry-updated"
  | "waitlist.entry-notified"
  | "waitlist.tables-assigned"
  | "waitlist.entry-removed"
  | "waitlist.entry-seated";

export async function writeWaitlistEvent(
  transaction: DatabaseTransaction,
  actor: Actor,
  eventType: WaitlistEventType,
  entryId: string,
  occurredAt: Date = new Date(),
): Promise<void> {
  await writeOutboxEvents(transaction, [
    {
      organizationId: actor.organizationId,
      locationId: actor.locationId,
      eventType,
      aggregateType: "waitlist_entry",
      aggregateId: entryId,
      payload: { waitlistEntryId: entryId },
      occurredAt,
    },
  ]);
}
