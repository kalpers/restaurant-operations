"use client";

import { Pin } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { sendApiRequest, type ApiFailure } from "@/components/forms/api-request";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import type { PreShiftNoteView } from "@/modules/restaurant/services/pre-shift-service";

type Failure = Pick<ApiFailure, "code" | "message" | "requestId">;
type Position = { id: string; name: string };

/** Phase 32 (policies 7–9): managers write, edit and withdraw pre-shift notes. */
export function PreShiftManager({ notes, positions, today }: { notes: PreShiftNoteView[]; positions: Position[]; today: string }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState<PreShiftNoteView | null>(null);
  const dates = [...new Set(notes.map((note) => note.businessDate))].sort();

  return (
    <div className="grid gap-6">
      <Card>
        <h2 className="mb-3 text-lg font-semibold">Write a note</h2>
        <NoteForm positions={positions} today={today} onDone={() => undefined} />
      </Card>
      {dates.length === 0 ? (
        <EmptyState title="No notes">There are no pre-shift notes for these dates.</EmptyState>
      ) : (
        dates.map((date) => (
          <section key={date} aria-label={`Notes for ${date}`} className="grid gap-3">
            <h2 className="text-lg font-semibold">{date === today ? `Today, ${date}` : date}</h2>
            <ul className="grid gap-3">
              {notes
                .filter((note) => note.businessDate === date)
                .map((note) => (
                  <li key={note.id}>
                    <Card className="grid gap-2" data-testid="managed-note">
                      {editing === note.id ? (
                        <NoteForm note={note} positions={positions} today={today} onDone={() => setEditing(null)} />
                      ) : (
                        <>
                          <div className="flex flex-wrap items-center gap-2">
                            {note.pinned && <Pin aria-label="Pinned" className="size-4 text-brand-700" />}
                            <h3 className="font-semibold">{note.title}</h3>
                            {!note.active && <Badge tone="danger">Withdrawn</Badge>}
                            {note.positions.length === 0 ? (
                              <Badge>Everyone</Badge>
                            ) : (
                              note.positions.map((position) => (
                                <Badge key={position.id} tone="info">
                                  {position.name}
                                </Badge>
                              ))
                            )}
                          </div>
                          <p className="whitespace-pre-wrap break-words text-sm">{note.body}</p>
                          <p className="text-xs text-neutral-600">
                            Written by {note.createdByName ?? "No employee record"}
                            {note.updatedByName !== note.createdByName || note.version > 1
                              ? `, last changed by ${note.updatedByName ?? "No employee record"}`
                              : ""}
                          </p>
                          {note.editable && (
                            <div className="flex flex-wrap gap-2">
                              <Button variant="secondary" onClick={() => setEditing(note.id)}>
                                Edit
                              </Button>
                              <Button variant="ghost" onClick={() => setWithdrawing(note)}>
                                Withdraw
                              </Button>
                            </div>
                          )}
                        </>
                      )}
                    </Card>
                  </li>
                ))}
            </ul>
          </section>
        ))
      )}
      <WithdrawDialog note={withdrawing} onClose={() => setWithdrawing(null)} />
    </div>
  );
}

function NoteForm({
  note,
  positions,
  today,
  onDone,
}: {
  note?: PreShiftNoteView;
  positions: Position[];
  today: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  // A position no longer active stays listed on the note it was chosen for.
  const choices = [...positions, ...(note?.positions.filter((kept) => !positions.some((p) => p.id === kept.id)) ?? [])];

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = event.currentTarget;
    const data = new FormData(form);
    const body = {
      businessDate: data.get("businessDate"),
      title: data.get("title"),
      body: data.get("body"),
      pinned: data.get("pinned") === "on",
      positionIds: data.getAll("positionIds"),
      ...(note ? { expectedVersion: note.version } : {}),
    };

    setPending(true);
    setError(null);

    const result = note
      ? await sendApiRequest("PATCH", `/api/pre-shift-notes/${note.id}`, body)
      : await sendApiRequest("POST", "/api/pre-shift-notes", body);

    setPending(false);

    if (result.ok) {
      if (!note) {
        form.reset();
      }

      toast.success(note ? "Note saved." : "Note added.");
      onDone();
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-3" aria-label={note ? `Edit ${note.title}` : "Write a note"}>
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <Field label="Business date">
          <Input type="date" name="businessDate" required min={today} defaultValue={note?.businessDate ?? today} />
        </Field>
        <Field label="Title">
          <Input name="title" required maxLength={120} defaultValue={note?.title ?? ""} />
        </Field>
      </div>
      <Field label="Note">
        <Textarea name="body" required maxLength={2000} rows={3} defaultValue={note?.body ?? ""} />
      </Field>
      <fieldset className="grid gap-1">
        <legend className="text-sm font-medium text-neutral-800">For (none chosen means everyone)</legend>
        <div className="flex flex-wrap gap-x-4">
          {choices.map((position) => (
            <Checkbox
              key={position.id}
              name="positionIds"
              value={position.id}
              label={position.name}
              defaultChecked={note?.positions.some((chosen) => chosen.id === position.id) ?? false}
            />
          ))}
        </div>
      </fieldset>
      <Checkbox name="pinned" label="Pin to the top" defaultChecked={note?.pinned ?? false} />
      <ApiErrorMessage error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" pending={pending} pendingLabel="Saving…">
          {note ? "Save note" : "Add note"}
        </Button>
        {note && (
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function WithdrawDialog({ note, onClose }: { note: PreShiftNoteView | null; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);

  async function handleConfirm() {
    if (!note) {
      return;
    }

    setPending(true);
    setError(null);

    const result = await sendApiRequest("POST", `/api/pre-shift-notes/${note.id}/withdraw`, { expectedVersion: note.version });

    setPending(false);

    if (result.ok) {
      toast.success("Note withdrawn.");
      onClose();
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <ConfirmDialog
      open={note !== null}
      title={note ? `Withdraw "${note.title}"?` : ""}
      body="Staff will no longer see it. It stays listed here as withdrawn."
      confirmLabel="Withdraw note"
      pending={pending}
      error={error ? <ApiErrorMessage error={error} /> : undefined}
      onConfirm={handleConfirm}
      onClose={() => {
        setError(null);
        onClose();
      }}
    />
  );
}
