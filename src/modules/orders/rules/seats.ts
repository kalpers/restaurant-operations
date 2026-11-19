import { sumDecimals } from "@/shared/decimal/decimal";
import { BusinessRuleError } from "@/shared/errors/app-error";

// Phase 29: seat numbers on order items and split by seat. A seat is 1 to 30; null is
// "Table" (shared, or not assigned). Pure rules, shared by the services and the order screen.

export const MIN_SEAT = 1;
export const MAX_SEAT = 30;

/** Policy 4: seats only on orders at a table session, never takeout (the move rule's condition). */
export function assertSeatAllowed(order: { orderType: string; tableSessionId: string | null }): void {
  if (order.tableSessionId === null || order.orderType === "TAKEOUT") {
    throw new BusinessRuleError("SEAT_NOT_ALLOWED", "Seats are only used on checks at a table.");
  }
}

/** Policy 2: a whole seat from 1 to 30, or null for "Table". */
export function validateSeat(seat: number | null): number | null {
  if (seat === null) {
    return null;
  }

  if (!Number.isInteger(seat) || seat < MIN_SEAT || seat > MAX_SEAT) {
    throw new BusinessRuleError("INVALID_SEAT", `Choose a seat from ${MIN_SEAT} to ${MAX_SEAT}, or Table.`);
  }

  return seat;
}

export type SeatPlanItem = { id: string; status: string; seatNumber: number | null };

export type SplitBySeatPlan = {
  /** The lowest seat with items; it stays on the source check with the "Table" items. */
  stayingSeat: number;
  /** Every other seat with items, lowest first, each going to its own new check. */
  moves: { seat: number; itemIds: string[] }[];
};

/** Items that never move in a split by seat: voided ones, and shared originals (amendment 5). */
export function staysOnSplit(status: string): boolean {
  return status === "VOIDED" || status === "SPLIT";
}

/**
 * Policy 9: which items go where when a check is split by seat. Voided items and shared
 * (SPLIT) originals never move: the move rules refuse them, and a shared item's money is
 * already on its share checks (amendment 5). They stay where they are. Fewer than two
 * seats with items that can move is refused.
 */
export function planSplitBySeat(items: readonly SeatPlanItem[]): SplitBySeatPlan {
  const bySeat = new Map<number, string[]>();

  for (const item of items) {
    if (staysOnSplit(item.status) || item.seatNumber === null) {
      continue;
    }

    bySeat.set(item.seatNumber, [...(bySeat.get(item.seatNumber) ?? []), item.id]);
  }

  const seats = [...bySeat.keys()].sort((a, b) => a - b);

  if (seats.length < 2) {
    throw new BusinessRuleError("NOTHING_TO_SPLIT", "Put items on at least two seats to split the check by seat.");
  }

  return {
    stayingSeat: seats[0]!,
    moves: seats.slice(1).map((seat) => ({ seat, itemIds: [...bySeat.get(seat)!].sort() })),
  };
}

export type SeatSubtotal = { seat: number | null; amount: string; lineCount: number };

/**
 * Policy 11: the sum of line amounts per seat, before check discounts and tax, seats in
 * order and "Table" (null) last. The caller decides each line's amount on this check.
 */
export function seatSubtotals(lines: readonly { seatNumber: number | null; amount: string }[]): SeatSubtotal[] {
  const groups = new Map<number | null, string[]>();

  for (const line of lines) {
    groups.set(line.seatNumber, [...(groups.get(line.seatNumber) ?? []), line.amount]);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([seat, amounts]) => ({ seat, amount: sumDecimals(amounts, 2), lineCount: amounts.length }));
}

/** Short label for screens and tickets: "S2", or "Table". */
export function seatLabel(seat: number | null): string {
  return seat === null ? "Table" : `S${seat}`;
}
