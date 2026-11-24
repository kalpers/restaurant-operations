"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { sendApiJson, type ApiFailure } from "@/components/forms/api-request";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import type { EventStatus } from "@/modules/reservations/rules/event-rules";

type Failure = Pick<ApiFailure, "code" | "message" | "requestId">;

const MOVES: Record<EventStatus, { to: "INQUIRY" | "TENTATIVE" | "CONFIRMED"; label: string }[]> = {
  INQUIRY: [
    { to: "TENTATIVE", label: "Hold tentatively" },
    { to: "CONFIRMED", label: "Confirm" },
  ],
  TENTATIVE: [
    { to: "CONFIRMED", label: "Confirm" },
    { to: "INQUIRY", label: "Release hold (back to inquiry)" },
  ],
  CONFIRMED: [{ to: "TENTATIVE", label: "Back to tentative" }],
  COMPLETED: [],
  CANCELLED: [],
};

/** Phase 36 (policy 7): status moves, cancelling with a reason, and seating a confirmed event. */
export function EventActions({
  eventId,
  status,
  version,
  canManage,
  canSeat,
}: {
  eventId: string;
  status: EventStatus;
  version: number;
  canManage: boolean;
  canSeat: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");

  async function call(key: string, url: string, body: unknown, success: string) {
    setBusy(key);
    setError(null);

    const result = await sendApiJson("POST", url, body);

    setBusy(null);

    if (result.ok) {
      toast.success(success);
      setCancelling(false);
      router.refresh();

      return true;
    }

    setError(result);

    return false;
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {canManage &&
          MOVES[status].map((move) => (
            <Button
              key={move.to}
              variant={move.to === "CONFIRMED" ? "primary" : "secondary"}
              pending={busy === move.to}
              disabled={busy !== null}
              onClick={() => call(move.to, `/api/events/${eventId}/status`, { status: move.to, expectedVersion: version }, "Event updated.")}
            >
              {move.label}
            </Button>
          ))}
        {canSeat && status === "CONFIRMED" && (
          <Button
            variant="primary"
            pending={busy === "seat"}
            disabled={busy !== null}
            onClick={() => call("seat", `/api/events/${eventId}/seat`, { expectedVersion: version }, "Event seated.")}
          >
            Seat the event
          </Button>
        )}
        {canManage && (status === "INQUIRY" || status === "TENTATIVE" || status === "CONFIRMED") && (
          <Button variant="ghost" disabled={busy !== null} onClick={() => setCancelling(true)}>
            Cancel event
          </Button>
        )}
      </div>
      <ApiErrorMessage error={error} />
      <Dialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title="Cancel this event?"
        description="The space is released and the party is cancelled. A cancelled event can't be reopened."
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelling(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              pending={busy === "cancel"}
              disabled={!reason.trim()}
              onClick={() =>
                call("cancel", `/api/events/${eventId}/status`, { status: "CANCELLED", reason, expectedVersion: version }, "Event cancelled.")
              }
            >
              Cancel event
            </Button>
          </>
        }
      >
        <Field label="Reason">
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={3} />
        </Field>
      </Dialog>
    </div>
  );
}
