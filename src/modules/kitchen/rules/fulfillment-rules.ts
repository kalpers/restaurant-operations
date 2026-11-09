import { BusinessRuleError } from "@/shared/errors/app-error";

import type { FulfillmentAction, KitchenItemStatus, StationType } from "../types";

// Pure fulfillment rules (Phase 10 approved policies 1, 2, 4, 6 and 8). No database access.

const ACTION_EDGES: Record<FulfillmentAction, { from: KitchenItemStatus; to: KitchenItemStatus }> = {
  start: { from: "NEW", to: "PREPARING" },
  ready: { from: "PREPARING", to: "READY" },
  complete: { from: "READY", to: "COMPLETED" },
};

export const TERMINAL_STATUSES: readonly KitchenItemStatus[] = ["COMPLETED", "CANCELLED"];
/** Statuses a void or cancellation may still end. */
export const ACTIVE_STATUSES: readonly KitchenItemStatus[] = ["NEW", "PREPARING", "READY"];

export type TransitionPlan =
  | { kind: "apply"; from: KitchenItemStatus; to: KitchenItemStatus }
  /** The item is already where the action leads: a repeated tap or retry. Nothing is written. */
  | { kind: "already"; to: KitchenItemStatus };

/**
 * The single allowed step for an action. Repeating an action on an item that is already in
 * its target state is an idempotent success; anything else (NEW -> READY, going backward,
 * leaving COMPLETED or CANCELLED) is refused. There is no recall: re-preparation is a Remake.
 */
export function planTransition(current: KitchenItemStatus, action: FulfillmentAction): TransitionPlan {
  const edge = ACTION_EDGES[action];

  if (current === edge.from) {
    return { kind: "apply", from: edge.from, to: edge.to };
  }

  if (current === edge.to) {
    return { kind: "already", to: edge.to };
  }

  if (current === "CANCELLED") {
    throw new BusinessRuleError("FULFILLMENT_ITEM_CANCELLED", "This item was cancelled.");
  }

  if (TERMINAL_STATUSES.includes(current)) {
    throw new BusinessRuleError(
      "FULFILLMENT_ITEM_TERMINAL",
      "This item is already completed. Use a remake to prepare it again.",
    );
  }

  throw new BusinessRuleError(
    "FULFILLMENT_INVALID_TRANSITION",
    `An item that is ${current.toLowerCase()} can't be ${
      action === "start" ? "started" : action === "ready" ? "marked ready" : "completed"
    }.`,
  );
}

/**
 * Ticket status, derived from its items with the approved precedence. Also used for an
 * Order Item's overall fulfillment across every station and attempt.
 */
export function deriveTicketStatus(statuses: readonly KitchenItemStatus[]): KitchenItemStatus {
  if (statuses.length === 0 || statuses.every((status) => status === "CANCELLED")) {
    return "CANCELLED";
  }

  if (
    statuses.every((status) => TERMINAL_STATUSES.includes(status)) &&
    statuses.includes("COMPLETED")
  ) {
    return "COMPLETED";
  }

  const live = statuses.filter((status) => status !== "CANCELLED");

  if (live.every((status) => status === "READY" || status === "COMPLETED") && live.includes("READY")) {
    return "READY";
  }

  if (statuses.includes("PREPARING")) {
    return "PREPARING";
  }

  return "NEW";
}

/**
 * Approved policy 6. `UNPREPARED` only when every station item of every attempt is NEW;
 * then all of them are cancelled. `PREPARED_OR_DISCARDED` cancels NEW, PREPARING and READY
 * and leaves COMPLETED and CANCELLED history as it is.
 */
export function planVoidCancellation(
  items: readonly { id: string; status: KitchenItemStatus }[],
  disposition: "UNPREPARED" | "PREPARED_OR_DISCARDED",
): { cancelIds: string[] } {
  if (disposition === "UNPREPARED" && items.some((item) => item.status !== "NEW")) {
    throw new BusinessRuleError(
      "FULFILLMENT_ALREADY_STARTED",
      "The kitchen or bar has already started this item, so it can't be voided as not prepared. Void it as prepared or discarded.",
    );
  }

  return {
    cancelIds: items.filter((item) => ACTIVE_STATUSES.includes(item.status)).map((item) => item.id),
  };
}

/** Approved policy 4: FIFO by submission instant, then ticket ID, then item ID. */
export function compareQueue(
  a: { submittedAt: Date; ticketId: string; id: string },
  b: { submittedAt: Date; ticketId: string; id: string },
): number {
  return (
    a.submittedAt.getTime() - b.submittedAt.getTime() ||
    (a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Groups routed station IDs into tickets (approved policies 2, 3 and 5): one ticket per
 * station that prepares something, in snapshot order. EXPO-type stations are a read-only
 * view, not a preparation hop, so they get no work. Unknown stations are refused rather
 * than invented.
 */
export function groupByStation<Item extends { prepStationIds: readonly string[] }>(
  items: readonly Item[],
  stationTypes: ReadonlyMap<string, StationType | "EXPO">,
): Map<string, Item[]> {
  const groups = new Map<string, Item[]>();

  for (const item of items) {
    for (const stationId of new Set(item.prepStationIds)) {
      const type = stationTypes.get(stationId);

      if (!type) {
        throw new BusinessRuleError(
          "PREP_STATION_NOT_FOUND",
          "An item is routed to a preparation station that doesn't exist at this location.",
        );
      }

      if (type === "EXPO") {
        continue;
      }

      groups.set(stationId, [...(groups.get(stationId) ?? []), item]);
    }
  }

  return groups;
}

export type AgeBand = "normal" | "warning" | "late";

/** Display-only aging. Never changes fulfillment state. */
export const AGE_THRESHOLDS_MINUTES = { warning: 10, late: 20 } as const;

export function ageBand(submittedAt: Date, now: Date): AgeBand {
  const minutes = (now.getTime() - submittedAt.getTime()) / 60_000;

  if (minutes >= AGE_THRESHOLDS_MINUTES.late) {
    return "late";
  }

  return minutes >= AGE_THRESHOLDS_MINUTES.warning ? "warning" : "normal";
}
