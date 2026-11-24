"use client";

import { Check, MinusCircle } from "lucide-react";
import { useState } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { isStaleConflict, sendApiJson, type ApiFailure } from "@/components/forms/api-request";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import type { ChecklistRunItemView, ChecklistRunView } from "@/modules/restaurant/services/checklist-service";

import { ChecklistStatusBadge, CHECKLIST_KIND_LABELS } from "./checklist-status-badge";

type Failure = Pick<ApiFailure, "code" | "message" | "requestId">;

const timeOf = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");

/**
 * Phase 36 (policy 5): one checklist. Each item is ticked done, skipped with a reason, or put
 * back, and saved on its own, so several people can work through one list at once.
 */
export function ChecklistRunView({ initial }: { initial: ChecklistRunView }) {
  const toast = useToast();
  const [run, setRun] = useState(initial);
  const [error, setError] = useState<Failure | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [skipping, setSkipping] = useState<ChecklistRunItemView | null>(null);
  const [noting, setNoting] = useState<ChecklistRunItemView | null>(null);
  const requiredOpen = run.items.filter((item) => item.required && item.state === "OPEN").length;

  async function call(key: string, method: string, url: string, body: unknown, success?: string) {
    setBusy(key);
    setError(null);

    const result = await sendApiJson<ChecklistRunView>(method, url, body);

    setBusy(null);

    if (result.ok) {
      setRun(result.data);

      if (success) {
        toast.success(success);
      }

      return true;
    }

    setError(result);

    if (isStaleConflict(result)) {
      const fresh = await sendApiJson<ChecklistRunView>("GET", `/api/checklists/runs/${run.id}`);

      if (fresh.ok) {
        setRun(fresh.data);
      }
    }

    return false;
  }

  const setItem = (item: ChecklistRunItemView, state: ChecklistRunItemView["state"], extra: { skipReason?: string; note?: string | null } = {}) =>
    call(item.id, "PATCH", `/api/checklists/items/${item.id}`, {
      state,
      note: extra.note === undefined ? item.note : extra.note,
      skipReason: extra.skipReason ?? null,
      expectedVersion: item.version,
    });

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <ChecklistStatusBadge status={run.status} />
        <Badge>{CHECKLIST_KIND_LABELS[run.kind]}</Badge>
        {run.employeeName && <Badge tone="info">{run.employeeName}</Badge>}
        <span className="text-sm text-neutral-700">Business date {run.businessDate}</span>
      </div>
      <ApiErrorMessage error={error} />
      <ul className="grid gap-2" aria-label="Checklist items">
        {run.items.map((item) => (
          <li key={item.id}>
            <Card className="grid gap-2" data-testid="checklist-item">
              <div className="flex flex-wrap items-start gap-3">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={item.state === "DONE"}
                  aria-label={item.text}
                  disabled={!item.changeable || busy !== null || (item.state === "SKIPPED" && !item.changeable)}
                  onClick={() => setItem(item, item.state === "DONE" ? "OPEN" : "DONE")}
                  className="flex size-11 shrink-0 items-center justify-center rounded-md border-2 border-neutral-400 bg-surface disabled:opacity-60 aria-checked:border-success-600 aria-checked:bg-success-50"
                >
                  {item.state === "DONE" && <Check aria-hidden className="size-6 text-success-700" />}
                  {item.state === "SKIPPED" && <MinusCircle aria-hidden className="size-6 text-warning-700" />}
                </button>
                <div className="grid min-w-0 flex-1 gap-1">
                  <p className={item.state === "OPEN" ? "font-medium" : "font-medium text-neutral-700"}>
                    {item.text}
                    {!item.required && <span className="ml-2 text-xs font-normal text-neutral-600">(optional)</span>}
                  </p>
                  {item.state !== "OPEN" && (
                    <p className="text-xs text-neutral-600">
                      {item.state === "DONE" ? "Done" : "Skipped"} by {item.actedByName ?? "No employee record"} at {timeOf(item.actedAt)}
                      {item.skipReason ? `: ${item.skipReason}` : ""}
                    </p>
                  )}
                  {item.note && <p className="whitespace-pre-wrap break-words text-sm">Note: {item.note}</p>}
                </div>
              </div>
              {run.workable && (
                <div className="flex flex-wrap gap-2">
                  {item.state === "OPEN" && (
                    <Button variant="ghost" disabled={busy !== null} onClick={() => setSkipping(item)}>
                      Skip
                    </Button>
                  )}
                  {item.state === "SKIPPED" && item.changeable && (
                    <Button variant="ghost" disabled={busy !== null} onClick={() => setItem(item, "OPEN")}>
                      Undo skip
                    </Button>
                  )}
                  <Button variant="ghost" disabled={busy !== null} onClick={() => setNoting(item)}>
                    {item.note ? "Edit note" : "Add note"}
                  </Button>
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>
      {run.workable && (
        <div className="grid gap-1">
          <Button
            variant="primary"
            size="lg"
            disabled={requiredOpen > 0 || busy !== null}
            pending={busy === "complete"}
            pendingLabel="Completing…"
            onClick={() => call("complete", "POST", `/api/checklists/runs/${run.id}/complete`, { expectedVersion: run.version }, "Checklist completed.")}
          >
            Complete checklist
          </Button>
          {requiredOpen > 0 && (
            <p className="text-sm text-neutral-700">
              {requiredOpen === 1 ? "1 required item is" : `${requiredOpen} required items are`} still open.
            </p>
          )}
        </div>
      )}
      {run.completedAt && (
        <p className="text-sm text-neutral-700">
          Completed by {run.completedByName ?? "No employee record"} at {timeOf(run.completedAt)}.
          {run.signedOffAt && ` Signed off by ${run.signedOffByName ?? "No employee record"} at ${timeOf(run.signedOffAt)}.`}
        </p>
      )}
      {run.canSignOff && (
        <Button
          variant="primary"
          pending={busy === "sign-off"}
          pendingLabel="Signing off…"
          onClick={() => call("sign-off", "POST", `/api/checklists/runs/${run.id}/sign-off`, { expectedVersion: run.version }, "Checklist signed off.")}
        >
          Sign off
        </Button>
      )}
      <TextDialog
        title={skipping ? `Skip "${skipping.text}"?` : ""}
        label="Why is it skipped?"
        maxLength={200}
        confirmLabel="Skip item"
        open={skipping !== null}
        required
        onClose={() => setSkipping(null)}
        onConfirm={async (text) => (skipping ? setItem(skipping, "SKIPPED", { skipReason: text }) : false)}
      />
      <TextDialog
        title={noting ? `Note on "${noting.text}"` : ""}
        label="Note"
        maxLength={500}
        confirmLabel="Save note"
        open={noting !== null}
        initial={noting?.note ?? ""}
        onClose={() => setNoting(null)}
        onConfirm={async (text) => (noting ? setItem(noting, noting.state, { note: text.trim() ? text : null, skipReason: noting.skipReason ?? undefined }) : false)}
      />
    </div>
  );
}

function TextDialog({
  title,
  label,
  maxLength,
  confirmLabel,
  open,
  initial = "",
  required = false,
  onClose,
  onConfirm,
}: {
  title: string;
  label: string;
  maxLength: number;
  confirmLabel: string;
  open: boolean;
  initial?: string;
  required?: boolean;
  onClose: () => void;
  onConfirm: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState(initial);
  const [pending, setPending] = useState(false);
  const [shownFor, setShownFor] = useState<string | null>(null);

  // Reset the text each time the dialog opens for a different item.
  if (open && shownFor !== title) {
    setShownFor(title);
    setText(initial);
  }

  function close() {
    setShownFor(null);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            pending={pending}
            disabled={required && !text.trim()}
            onClick={async () => {
              setPending(true);

              const ok = await onConfirm(text);

              setPending(false);

              if (ok) {
                close();
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Field label={label}>
        <Textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={maxLength} rows={3} />
      </Field>
    </Dialog>
  );
}
