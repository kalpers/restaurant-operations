import { Badge, type Tone } from "@/components/ui/badge";
import type { EventSpaceScope, EventStatus } from "@/modules/reservations/rules/event-rules";

const STATUS: Record<EventStatus, { label: string; tone: Tone }> = {
  INQUIRY: { label: "Inquiry", tone: "neutral" },
  TENTATIVE: { label: "Tentative", tone: "warning" },
  CONFIRMED: { label: "Confirmed", tone: "success" },
  COMPLETED: { label: "Completed", tone: "info" },
  CANCELLED: { label: "Cancelled", tone: "danger" },
};

/** Phase 36 (policy 7): an event's status. */
export function EventStatusBadge({ status }: { status: EventStatus }) {
  return <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>;
}

/** How an event's space reads, e.g. "Patio (whole area)", "Tables 4, 5", "Whole location". */
export function describeEventSpace(event: { spaceScope: EventSpaceScope; area: { name: string } | null; tables: { tableNumber: string }[] }) {
  if (event.spaceScope === "LOCATION") {
    return "Whole location (buyout)";
  }

  if (event.spaceScope === "AREA") {
    return `${event.area?.name ?? "Area"} (whole area)`;
  }

  return `${event.area?.name ?? ""} tables ${event.tables.map((table) => table.tableNumber).join(", ")}`.trim();
}
