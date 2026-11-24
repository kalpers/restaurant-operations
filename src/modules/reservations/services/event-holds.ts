import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import { ConflictError } from "@/shared/errors/app-error";

import { findEventBlocks, type EventBlock } from "../queries/event-blocks";
import type { Interval } from "../types";

// Phase 36 (policy 7): the event checks other planning code calls, beside its own rules.

function describeBlock(block: EventBlock, timeZone: string): string {
  const time = (at: Date) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(at);
  const what = block.scope === "LOCATION" ? "The location is booked out" : "That space is held";

  return `${what} for ${block.eventNumber} ${block.name}, ${time(block.interval.start)} to ${time(block.interval.end)}.`;
}

/**
 * Policy 7: refuses planning a reservation or waitlist party onto tables an event holds over
 * `interval`, or anything at all during a buyout when `buyouts` is "include".
 */
export async function assertNoEventBlock(
  executor: DatabaseExecutor,
  input: {
    locationId: string;
    timeZone: string;
    interval: Interval;
    tableIds: readonly string[];
    buyouts: "include" | "exclude";
    exceptGuestPartyId?: string | null;
  },
): Promise<void> {
  if (input.tableIds.length === 0 && input.buyouts === "exclude") {
    return;
  }

  const [block] = await findEventBlocks(executor, {
    locationId: input.locationId,
    interval: input.interval,
    tableIds: input.tableIds,
    buyouts: input.buyouts,
    exceptGuestPartyId: input.exceptGuestPartyId,
  });

  if (block) {
    throw new ConflictError("EVENT_CONFLICT", describeBlock(block, input.timeZone));
  }
}

export { describeBlock as describeEventBlock };
