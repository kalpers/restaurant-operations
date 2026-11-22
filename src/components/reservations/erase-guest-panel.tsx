"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { readFailure, sendApiRequest, NETWORK_FAILURE_MESSAGE, type ApiFailure } from "@/components/forms/api-request";
import { apiFetch } from "@/components/forms/page-location";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, FieldHint, Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import type { GuestMention, MentionKind, MentionPreview } from "@/workflows/erase-guest/erase-guest";

type Failure = Pick<ApiFailure, "code" | "message" | "requestId">;

/** Phase 34 (amendment 6): how each kind of mention is headed in the list, in this order. */
const KIND_HEADINGS: Record<MentionKind, string> = {
  LOG_ENTRY: "Manager log",
  NOTE: "Pre-shift notes",
  PARTY_REQUEST: "Special requests on other visits",
  RESERVATION_NOTE: "Reservation notes",
  WAITLIST_NOTE: "Waitlist notes",
  SESSION_NOTE: "Table notes",
  TAKEOUT_NAME: "Takeout names",
  ORDER_ITEM_INSTRUCTION: "Order item instructions (and kitchen tickets)",
  SHIFT_NOTE: "Shift notes",
  ASSIGNMENT_NOTE: "Shift assignment notes",
  GIFT_CARD_PURCHASER: "Gift card purchasers",
};

const KIND_ORDER = Object.keys(KIND_HEADINGS) as MentionKind[];

/**
 * Phase 33 (policies 2–4): an erase lists the manager log entries and pre-shift notes that may
 * mention the guest, all ticked. Ticked ones are redacted with the erase, in one step; the
 * rest stay as they are. Matching is only a suggestion, so read each one before confirming.
 * Phase 34 (policies 11–14): every other place staff type free text is searched too; there
 * only the guest's words are replaced with "[redacted]", and a gift card purchaser is cleared.
 */
export function EraseGuestPanel({
  mentionsUrl,
  eraseUrl,
  expectedVersion,
  description,
  submitLabel,
  onDone,
}: {
  mentionsUrl: string;
  eraseUrl: string;
  expectedVersion: number;
  description: string;
  submitLabel: string;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [preview, setPreview] = useState<MentionPreview | null>(null);
  const [loadError, setLoadError] = useState<Failure | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await apiFetch(mentionsUrl);

        if (cancelled) {
          return;
        }

        if (!response.ok) {
          setLoadError(await readFailure(response));

          return;
        }

        const data = (await response.json()) as MentionPreview;

        setPreview(data);
        setChosen(new Set(data.mentions.map((mention) => `${mention.kind}:${mention.id}`)));
      } catch {
        if (!cancelled) {
          setLoadError({ code: "NETWORK", message: NETWORK_FAILURE_MESSAGE });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mentionsUrl]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const picked = [...chosen];
    const result = await sendApiRequest("POST", eraseUrl, {
      expectedVersion,
      reason,
      redactEntryIds: picked.filter((key) => key.startsWith("LOG_ENTRY:")).map((key) => key.slice("LOG_ENTRY:".length)),
      redactNoteIds: picked.filter((key) => key.startsWith("NOTE:")).map((key) => key.slice("NOTE:".length)),
      redactMentions: picked
        .map((key) => {
          const [kind, id] = key.split(":") as [MentionKind, string];

          return { kind, id };
        })
        .filter((mention) => mention.kind !== "LOG_ENTRY" && mention.kind !== "NOTE"),
    });

    setPending(false);

    if (result.ok) {
      toast.success("Erased.");
      onDone?.();
      router.refresh();
    } else {
      setError(result);
    }
  }

  function toggle(key: string, on: boolean) {
    setChosen((current) => {
      const next = new Set(current);

      if (on) {
        next.add(key);
      } else {
        next.delete(key);
      }

      return next;
    });
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Erase guest details" className="grid gap-3">
      <p className="text-sm">{description}</p>
      <section aria-label="Possible mentions" className="grid gap-2">
        <h3 className="font-semibold">Possible mentions in notes, orders and schedules</h3>
        {loadError && <ApiErrorMessage error={loadError} />}
        {!preview && !loadError && <p className="text-sm text-neutral-600">Searching…</p>}
        {preview && preview.mentions.length === 0 && (
          <p className="text-sm text-neutral-700">Nothing found that mentions this guest&apos;s name, email or phone.</p>
        )}
        {preview && preview.mentions.length > 0 && (
          <>
            <FieldHint>
              Ticked ones are redacted with the erase, for good: log entries and pre-shift notes are emptied; elsewhere only
              the guest&apos;s name, email or phone is replaced with [redacted]. Untick anything that isn&apos;t about this guest.
            </FieldHint>
            {KIND_ORDER.filter((kind) => preview.mentions.some((mention) => mention.kind === kind)).map((kind) => (
              <div key={kind} className="grid gap-2" data-testid={`guest-mentions-${kind}`}>
                <h4 className="text-sm font-semibold">{KIND_HEADINGS[kind]}</h4>
                <ul className="grid gap-2">
                  {preview.mentions
                    .filter((mention) => mention.kind === kind)
                    .map((mention) => (
                      <MentionRow key={`${mention.kind}:${mention.id}`} mention={mention} chosen={chosen} onToggle={toggle} />
                    ))}
                </ul>
              </div>
            ))}
          </>
        )}
        {preview && preview.notSearched.length > 0 && (
          <p className="text-sm text-neutral-700">
            Not searched, because you can&apos;t see them:{" "}
            {preview.notSearched
              .map((entry) =>
                entry.kind === "GIFT_CARD_PURCHASER"
                  ? "gift card purchasers"
                  : `${KIND_HEADINGS[entry.kind].toLowerCase()} at ${entry.locations === 1 ? "1 location" : `${entry.locations} locations`}`,
              )
              .join("; ")}
            .
          </p>
        )}
      </section>
      <Field label="Reason">
        <Input required maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <FieldHint>Don&apos;t put the guest&apos;s name in the reason.</FieldHint>
      <ApiErrorMessage error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" pending={pending} pendingLabel="Erasing…" disabled={!preview && !loadError}>
          {submitLabel}
        </Button>
        {onDone && (
          <Button type="button" variant="secondary" onClick={onDone}>
            Keep
          </Button>
        )}
      </div>
    </form>
  );
}

function MentionRow({
  mention,
  chosen,
  onToggle,
}: {
  mention: GuestMention;
  chosen: ReadonlySet<string>;
  onToggle: (key: string, on: boolean) => void;
}) {
  const key = `${mention.kind}:${mention.id}`;
  const where = [mention.locationName, mention.businessDate].filter(Boolean).join(", ");

  return (
    <li className="rounded border border-neutral-200 bg-surface p-2" data-testid="guest-mention">
      <Checkbox
        checked={chosen.has(key)}
        onChange={(event) => onToggle(key, event.target.checked)}
        label={
          <span>
            <span className="font-medium">{mention.kind === "NOTE" ? `Pre-shift note "${mention.label}"` : mention.label}</span>{" "}
            {where && <span className="text-neutral-600">{where}</span>}
            <span className="block text-neutral-800">{mention.excerpt}</span>
          </span>
        }
      />
    </li>
  );
}
