import type { Database } from "@/db";
import type { Actor } from "@/modules/auth/types";
import { checkHoldsForSeating, recordHoldOverrides } from "@/modules/reservations/services/hold-service";
import {
  addTableToSession,
  moveSession,
  type NewTablesCheck,
} from "@/modules/restaurant/services/session-service";

// Phase 20 (policy 8, D7): moving or combining a seated party onto a table held for another
// party's reservation follows the seating rule. It is refused while the hold is in effect,
// unless the user holds `reservations.override-hold` and gives a reason, which is recorded.
// The check runs inside the move's own transaction, after the tables are locked.

function holdCheck(actor: Actor, overrideReason: string | null | undefined): NewTablesCheck {
  return async (transaction, input) => {
    const holds = await checkHoldsForSeating(transaction, actor, {
      tableIds: input.tableIds,
      guestPartyId: input.guestPartyId,
      overrideReason,
      now: input.now,
    });

    if (holds.reason) {
      await recordHoldOverrides(transaction, actor, {
        sessionId: input.sessionId,
        holds: holds.overridden,
        reason: holds.reason,
        occurredAt: input.now,
      });
    }
  };
}

export async function moveTableSession(
  database: Database,
  actor: Actor,
  sessionId: string,
  input: {
    tableIds: readonly string[];
    capacityOverrideReason?: string | null;
    holdOverrideReason?: string | null;
    expectedVersion: number;
  },
) {
  return moveSession(database, actor, sessionId, input, holdCheck(actor, input.holdOverrideReason));
}

export async function combineTableIntoSession(
  database: Database,
  actor: Actor,
  sessionId: string,
  input: {
    tableId: string;
    capacityOverrideReason?: string | null;
    holdOverrideReason?: string | null;
    expectedVersion: number;
  },
) {
  return addTableToSession(database, actor, sessionId, input, holdCheck(actor, input.holdOverrideReason));
}
