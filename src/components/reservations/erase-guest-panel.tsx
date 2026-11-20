"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { readFailure, sendApiRequest, NETWORK_FAILURE_MESSAGE, type ApiFailure } from "@/components/forms/api-request";
import { apiFetch } from "@/components/forms/page-location";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, FieldHint, Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import type { MentionPreview } from "@/workflows/erase-guest/erase-guest";

type Failure = Pick<ApiFailure, "code" | "message" | "requestId">;

/**
 * Phase 33 (policies 2–4): an erase lists the manager log entries and pre-shift notes that may
 * mention the guest, all ticked. Ticked ones are redacted with the erase, in one step; the
 * rest stay as they are. Matching is only a suggestion, so read each one before confirming.
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
        <h3 className="font-semibold">Possible mentions in the manager log and pre-shift notes</h3>
        {loadError && <ApiErrorMessage error={loadError} />}
        {!preview && !loadError && <p className="text-sm text-neutral-600">Searching…</p>}
        {preview && preview.mentions.length === 0 && (
          <p className="text-sm text-neutral-700">Nothing found that mentions this guest&apos;s name, email or phone.</p>
        )}
        {preview && preview.mentions.length > 0 && (
          <>
            <FieldHint>
              Ticked ones are redacted with the erase, for good. Untick anything that isn&apos;t about this guest.
            </FieldHint>
            <ul className="grid gap-2">
              {preview.mentions.map((mention) => {
                const key = `${mention.kind}:${mention.id}`;

                return (
                  <li key={key} className="rounded border border-neutral-200 bg-surface p-2" data-testid="guest-mention">
                    <Checkbox
                      checked={chosen.has(key)}
                      onChange={(event) => toggle(key, event.target.checked)}
                      label={
                        <span>
                          <span className="font-medium">
                            {mention.kind === "LOG_ENTRY" ? mention.label : `Pre-shift note "${mention.label}"`}
                          </span>{" "}
                          <span className="text-neutral-600">
                            {mention.locationName}, {mention.businessDate}
                          </span>
                          <span className="block text-neutral-800">{mention.excerpt}</span>
                        </span>
                      }
                    />
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {preview && preview.locationsNotSearched > 0 && (
          <p className="text-sm text-neutral-700">
            {preview.locationsNotSearched === 1 ? "1 other location wasn't" : `${preview.locationsNotSearched} other locations weren't`}{" "}
            searched: you can&apos;t redact the manager log there.
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
