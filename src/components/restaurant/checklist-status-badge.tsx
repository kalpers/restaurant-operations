import { Badge, type Tone } from "@/components/ui/badge";
import type { ChecklistKind } from "@/db/schema/checklists";
import type { DisplayStatus } from "@/modules/restaurant/rules/checklist-rules";

const STATUS: Record<DisplayStatus, { label: string; tone: Tone }> = {
  NOT_STARTED: { label: "Not started", tone: "neutral" },
  IN_PROGRESS: { label: "In progress", tone: "info" },
  NOT_COMPLETED: { label: "Not completed", tone: "danger" },
  AWAITING_SIGN_OFF: { label: "Awaiting sign-off", tone: "warning" },
  COMPLETED: { label: "Completed", tone: "success" },
  SIGNED_OFF: { label: "Signed off", tone: "success" },
};

export const CHECKLIST_KIND_LABELS: Record<ChecklistKind, string> = {
  OPENING: "Opening",
  CLOSING: "Closing",
  SIDE_WORK: "Side work",
  OTHER: "Other",
};

/** Phase 36 (policy 5): a checklist's status as worked out on read. */
export function ChecklistStatusBadge({ status }: { status: DisplayStatus }) {
  return <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>;
}
