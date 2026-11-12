"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import type { GuestMessageView as ServerMessageView } from "@/modules/reservations/services/guest-message-service";

import { BUTTON_CLASS, ErrorText, formatDay, formatTime, useSubmit } from "./shared";

// Phase 22 (policies 6 and 16): consent at the host stand, and a visit's message history.

export type MessageConsent = { sms: boolean; email: boolean };

/** A history row as the API sends it: instants are ISO strings. */
type GuestMessageView = Omit<ServerMessageView, "createdAt" | "sentAt" | "failedAt"> & {
  createdAt: string;
  sentAt: string | null;
  failedAt: string | null;
};

export type HostMessageAbilities = {
  /** `messages.view`. */
  view: boolean;
  /** `messages.resend`. */
  resend: boolean;
};

/** Two unticked boxes the host ticks only when the guest agreed (D5). */
export function MessageConsentFields({
  value,
  onChange,
}: {
  value: MessageConsent;
  onChange: (value: MessageConsent) => void;
}) {
  return (
    <fieldset className="grid gap-1 rounded border border-neutral-200 p-3">
      <legend className="px-1 text-sm font-medium">Messages about this visit</legend>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-5"
          checked={value.sms}
          onChange={(event) => onChange({ ...value, sms: event.target.checked })}
        />
        Guest agreed to texts
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-5"
          checked={value.email}
          onChange={(event) => onChange({ ...value, email: event.target.checked })}
        />
        Guest agreed to emails
      </label>
      <p className="text-xs text-neutral-600">
        Only booking confirmations, changes, reminders and table-ready messages. Tick a box only
        when the guest said yes.
      </p>
    </fieldset>
  );
}

const KIND_TEXT: Record<GuestMessageView["kind"], string> = {
  RESERVATION_CONFIRMED: "Confirmation",
  RESERVATION_RECEIVED: "Request received",
  RESERVATION_CHANGED: "Change",
  RESERVATION_CANCELLED: "Cancellation",
  RESERVATION_REMINDER: "Reminder",
  WAITLIST_TABLE_READY: "Table ready",
};

const STATUS_TONE: Record<GuestMessageView["status"], "neutral" | "success" | "warning" | "danger"> = {
  QUEUED: "neutral",
  SENDING: "neutral",
  SENT: "success",
  FAILED: "danger",
  SUPPRESSED: "warning",
  CANCELLED: "neutral",
};

const STATUS_TEXT: Record<GuestMessageView["status"], string> = {
  QUEUED: "Waiting to send",
  SENDING: "Sending",
  SENT: "Sent",
  FAILED: "Failed",
  SUPPRESSED: "Opted out",
  CANCELLED: "Not sent",
};

export function GuestMessagesPanel({
  subject,
  partyId,
  consent,
  canManageConsent,
  abilities,
  timeZone,
}: {
  subject:
    | { type: "reservation"; id: string; status: string }
    | { type: "waitlist"; id: string; status: string };
  partyId: string;
  consent: MessageConsent;
  canManageConsent: boolean;
  abilities: HostMessageAbilities;
  timeZone: string;
}) {
  const { submit, pending, error } = useSubmit();
  const [messages, setMessages] = useState<GuestMessageView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const url = subject.type === "reservation" ? `/api/reservations/${subject.id}/messages` : `/api/waitlist/${subject.id}/messages`;

  // Bumped after an action, so the history is read again.
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    if (!abilities.view) {
      return;
    }

    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(url);

        if (cancelled) {
          return;
        }

        if (response.ok) {
          const body = (await response.json()) as { messages: GuestMessageView[] };

          if (!cancelled) {
            setMessages(body.messages);
            setLoadError(null);
          }
        } else {
          setLoadError("Couldn't load the messages.");
        }
      } catch {
        if (!cancelled) {
          setLoadError("Couldn't load the messages.");
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [abilities.view, url, reloads]);

  const act = async (method: string, target: string) => {
    if (await submit(method, target, {})) {
      setReloads((count) => count + 1);
    }
  };
  const none = !consent.sms && !consent.email;

  return (
    <section aria-label="Guest messages" className="mt-3 grid gap-3 rounded-md border border-neutral-300 p-3">
      <h4 className="font-semibold">Messages</h4>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {none && <span>The guest hasn&apos;t agreed to texts or emails for this visit.</span>}
        {(["sms", "email"] as const)
          .filter((channel) => consent[channel])
          .map((channel) => (
            <span key={channel} className="inline-flex items-center gap-2">
              <Badge tone="brand">{channel === "sms" ? "Texts OK" : "Emails OK"}</Badge>
              {canManageConsent && (
                <button
                  type="button"
                  disabled={pending}
                  className={BUTTON_CLASS}
                  onClick={() => act("DELETE", `/api/guest-parties/${partyId}/message-consents/${channel.toUpperCase()}`)}
                >
                  Stop {channel === "sms" ? "texts" : "emails"}
                </button>
              )}
            </span>
          ))}
      </div>
      {abilities.resend && subject.type === "reservation" && subject.status === "CONFIRMED" && !none && (
        <div>
          <button
            type="button"
            disabled={pending}
            className={BUTTON_CLASS}
            onClick={() => act("POST", `/api/reservations/${subject.id}/messages/confirmation`)}
          >
            Send confirmation again
          </button>
        </div>
      )}
      {abilities.resend && subject.type === "waitlist" && subject.status === "NOTIFIED" && !none && (
        <div>
          <button
            type="button"
            disabled={pending}
            className={BUTTON_CLASS}
            onClick={() => act("POST", `/api/waitlist/${subject.id}/messages/table-ready`)}
          >
            Text again
          </button>
        </div>
      )}
      <ErrorText error={error ?? loadError} />
      {abilities.view && messages && messages.length === 0 && <p className="text-sm text-neutral-600">No messages yet.</p>}
      {abilities.view && messages && messages.length > 0 && (
        <ul className="grid gap-2" aria-label="Message history">
          {messages.map((message) => (
            <li key={message.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{KIND_TEXT[message.kind]}</span>
              <span>{message.channel === "SMS" ? "Text" : "Email"}</span>
              {message.recipient && <span className="text-neutral-600">to {message.recipient}</span>}
              <Badge tone={STATUS_TONE[message.status]}>{STATUS_TEXT[message.status]}</Badge>
              <span className="text-neutral-600">
                {formatDay(message.sentAt ?? message.createdAt, timeZone)} {formatTime(message.sentAt ?? message.createdAt, timeZone)}
              </span>
              {message.status === "FAILED" && abilities.resend && (
                <button
                  type="button"
                  disabled={pending}
                  className={BUTTON_CLASS}
                  onClick={() => act("POST", `/api/guest-messages/${message.id}/resend`)}
                >
                  Retry
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
