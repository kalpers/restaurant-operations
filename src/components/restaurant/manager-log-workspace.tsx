"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { readFailure, NETWORK_FAILURE_MESSAGE, type ApiFailure } from "@/components/forms/api-request";
import { apiFetch } from "@/components/forms/page-location";
import { useLocationTimeZone } from "@/components/time/location-time-zone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, FieldHint, Select, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import type { ManagerLogEntryView } from "@/modules/restaurant/services/manager-log-service";
import { formatInstant } from "@/shared/time/format-instant";

export const LOG_CATEGORY_LABELS: Record<string, string> = {
  SERVICE: "Service",
  INCIDENT: "Incident",
  MAINTENANCE: "Maintenance",
  STAFFING: "Staffing",
  GUEST: "Guest",
  OTHER: "Other",
};

type Failure = Pick<ApiFailure, "code" | "message" | "requestId">;

async function send(method: string, url: string, body: unknown, headers: Record<string, string> = {}) {
  try {
    const response = await apiFetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

    return response.ok ? ({ ok: true, status: response.status } as const) : await readFailure(response);
  } catch {
    return { ok: false, status: 0, code: "NETWORK", message: NETWORK_FAILURE_MESSAGE } as const;
  }
}

type Abilities = { write: boolean; redact: boolean };

/**
 * Phase 32 manager log (policies 3–6, 10). Adding and correcting entries; redacting one for
 * Owner and General Manager. Hidden controls are convenience: each API checks permissions.
 */
export function ManagerLogWorkspace({
  entries,
  abilities,
  currentDate,
  showDates,
}: {
  entries: ManagerLogEntryView[];
  abilities: Abilities;
  currentDate: string;
  /** True for a search across dates, where each entry shows its business date. */
  showDates: boolean;
}) {
  const [correcting, setCorrecting] = useState<ManagerLogEntryView | null>(null);
  const [redacting, setRedacting] = useState<ManagerLogEntryView | null>(null);

  return (
    <div className="grid gap-6">
      {abilities.write && (
        <AddEntryForm
          key={correcting?.id ?? "new"}
          currentDate={currentDate}
          correcting={correcting}
          onDone={() => setCorrecting(null)}
        />
      )}
      {entries.length === 0 ? (
        <EmptyState title="No entries">Nothing has been logged for this selection.</EmptyState>
      ) : (
        <ol className="grid gap-3" aria-label="Manager log entries">
          {entries.map((entry) => (
            <li key={entry.id}>
              <EntryCard
                entry={entry}
                showDate={showDates}
                abilities={abilities}
                onCorrect={() => {
                  setCorrecting(entry);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                onRedact={() => setRedacting(entry)}
              />
            </li>
          ))}
        </ol>
      )}
      <RedactDialog entry={redacting} onClose={() => setRedacting(null)} />
    </div>
  );
}

function EntryCard({
  entry,
  showDate,
  abilities,
  onCorrect,
  onRedact,
}: {
  entry: ManagerLogEntryView;
  showDate: boolean;
  abilities: Abilities;
  onCorrect: () => void;
  onRedact: () => void;
}) {
  const timeZone = useLocationTimeZone();

  return (
    <Card className="grid gap-2" data-testid="log-entry" aria-label={entry.entryNumber}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold tabular">{entry.entryNumber}</span>
        <Badge tone={entry.category === "INCIDENT" ? "warning" : "neutral"}>{LOG_CATEGORY_LABELS[entry.category] ?? entry.category}</Badge>
        {showDate && <span className="text-neutral-700">Business date {entry.businessDate}</span>}
        <span className="text-neutral-600">
          {formatInstant(entry.createdAt, timeZone, showDate ? "dateTime" : "time")} · {entry.authorName ?? "No employee record"}
        </span>
        {entry.correctedBy.length > 0 && <Badge tone="info">Corrected by {entry.correctedBy.join(", ")}</Badge>}
        {entry.redaction && <Badge tone="danger">Redacted</Badge>}
      </div>
      {entry.corrects && <p className="text-sm text-neutral-700">Corrects {entry.corrects.entryNumber}</p>}
      {entry.redaction ? (
        <p className="text-sm italic text-neutral-700">
          Redacted {formatInstant(entry.redaction.at, timeZone)} by {entry.redaction.byName ?? "No employee record"}. Reason:{" "}
          {entry.redaction.reason}
        </p>
      ) : (
        <p className="whitespace-pre-wrap break-words">{entry.body}</p>
      )}
      {(abilities.write || (abilities.redact && !entry.redaction)) && (
        <div className="flex flex-wrap gap-2">
          {abilities.write && (
            <Button variant="secondary" onClick={onCorrect}>
              Correct
            </Button>
          )}
          {abilities.redact && !entry.redaction && (
            <Button variant="ghost" onClick={onRedact}>
              Redact
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function AddEntryForm({
  currentDate,
  correcting,
  onDone,
}: {
  currentDate: string;
  correcting: ManagerLogEntryView | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const key = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const data = new FormData(event.currentTarget);

    key.current ??= `log-${crypto.randomUUID()}`;
    setPending(true);
    setError(null);

    const result = await send(
      "POST",
      "/api/manager-log",
      {
        dateChoice: data.get("dateChoice"),
        category: data.get("category"),
        body: data.get("body"),
        correctsEntryId: correcting?.id ?? null,
      },
      { "Idempotency-Key": key.current },
    );

    setPending(false);

    // A retry after a network failure reuses the key, so it can't add a second entry.
    if (result.ok || (result.status >= 400 && result.status < 500)) {
      key.current = null;
    }

    if (result.ok) {
      formRef.current?.reset();
      toast.success(correcting ? "Correction added." : "Entry added.");
      onDone();
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <Card>
      <form ref={formRef} onSubmit={handleSubmit} className="grid gap-3" aria-label={correcting ? "Correct an entry" : "Add an entry"}>
        <h2 className="text-lg font-semibold">{correcting ? `Correct ${correcting.entryNumber}` : "Add an entry"}</h2>
        {correcting && (
          <FieldHint>
            The original stays as it is, marked as corrected by this entry. Say what was wrong and what is right.
          </FieldHint>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Business date">
            <Select name="dateChoice" defaultValue="CURRENT">
              <option value="CURRENT">Today ({currentDate})</option>
              <option value="PREVIOUS">The previous business date</option>
            </Select>
          </Field>
          <Field label="Category">
            <Select name="category" defaultValue={correcting?.category ?? "SERVICE"}>
              {Object.entries(LOG_CATEGORY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Entry">
          <Textarea name="body" required maxLength={4000} rows={4} />
        </Field>
        <FieldHint>
          Entries can&apos;t be edited or deleted. Don&apos;t record guests&apos; contact details, health details or HR matters.
        </FieldHint>
        <ApiErrorMessage error={error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" pending={pending} pendingLabel="Saving…">
            {correcting ? "Add correction" : "Add entry"}
          </Button>
          {correcting && (
            <Button variant="ghost" onClick={onDone}>
              Cancel correction
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

function RedactDialog({ entry, onClose }: { entry: ManagerLogEntryView | null; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [reason, setReason] = useState("");

  function close() {
    setReason("");
    setError(null);
    onClose();
  }

  async function handleRedact() {
    if (!entry) {
      return;
    }

    setPending(true);
    setError(null);

    const result = await send("POST", `/api/manager-log/${entry.id}/redact`, { reason });

    setPending(false);

    if (result.ok) {
      toast.success(`${entry.entryNumber} redacted.`);
      close();
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <Dialog
      open={entry !== null}
      onClose={close}
      title={entry ? `Redact ${entry.entryNumber}?` : ""}
      description="The entry's text is removed for good. Its number, date, category and author stay, with your name and reason."
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Keep it
          </Button>
          <Button variant="danger" pending={pending} pendingLabel="Redacting…" disabled={!reason.trim()} onClick={handleRedact}>
            Redact entry
          </Button>
        </>
      }
    >
      <div className="grid gap-2">
        <Field label="Reason">
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={3} />
        </Field>
        <ApiErrorMessage error={error} />
      </div>
    </Dialog>
  );
}
