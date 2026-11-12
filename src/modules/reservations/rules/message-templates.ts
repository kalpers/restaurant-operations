import type { GuestMessageKind } from "@/db/schema/guest-messaging";
import type { MessageChannel } from "@/infrastructure/messaging/message-sender";

// Phase 22 message templates (D4, policy 2). Fixed text with service facts only: the location,
// date and time in the location's time zone, party size and the links. Never notes, special
// requests, allergies or anything staff typed. Staff can't add free text to a message.

export type MessageTemplateInput = {
  kind: GuestMessageKind;
  channel: MessageChannel;
  locationName: string;
  locationPhone: string | null;
  timeZone: string;
  /** The reservation time. Not used for the waitlist message. */
  at: Date | null;
  partySize: number;
  guestName: string;
  /** View-or-cancel link, for reservation kinds other than cancelled. */
  manageUrl: string | null;
  /** Email only. */
  unsubscribeUrl: string | null;
};

export type RenderedMessage = { subject: string | null; body: string };

/** "Fri, Nov 13 at 7:00 PM" in the location's time zone. */
export function formatMessageTime(at: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(at);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(at);

  return `${day} at ${time}`;
}

const SMS_OPT_OUT = "Reply STOP to opt out.";

function partyOf(size: number): string {
  return size === 1 ? "1 guest" : `${size} guests`;
}

/** The core sentence of each kind, shared by SMS and email. */
function sentence(input: MessageTemplateInput): string {
  const when = input.at ? formatMessageTime(input.at, input.timeZone) : "";
  const party = partyOf(input.partySize);

  switch (input.kind) {
    case "RESERVATION_CONFIRMED":
      return `Your reservation for ${party} on ${when} is confirmed.`;
    case "RESERVATION_RECEIVED":
      return `We received your request for ${party} on ${when}. We'll confirm it soon.`;
    case "RESERVATION_CHANGED":
      return `Your reservation is now for ${party} on ${when}.`;
    case "RESERVATION_CANCELLED":
      return `Your reservation for ${party} on ${when} is cancelled.`;
    case "RESERVATION_REMINDER":
      return `A reminder of your reservation for ${party} on ${when}.`;
    case "WAITLIST_TABLE_READY":
      return "Your table is ready. Please come to the host stand.";
  }
}

const SUBJECTS: Record<GuestMessageKind, string> = {
  RESERVATION_CONFIRMED: "Your reservation is confirmed",
  RESERVATION_RECEIVED: "We received your reservation request",
  RESERVATION_CHANGED: "Your reservation has changed",
  RESERVATION_CANCELLED: "Your reservation is cancelled",
  RESERVATION_REMINDER: "Reservation reminder",
  WAITLIST_TABLE_READY: "Your table is ready",
};

export function renderGuestMessage(input: MessageTemplateInput): RenderedMessage {
  const core = sentence(input);
  const manage = input.manageUrl ? `View or cancel: ${input.manageUrl}` : null;
  const call =
    input.kind === "RESERVATION_CANCELLED" && input.locationPhone ? `Questions? Call ${input.locationPhone}.` : null;

  if (input.channel === "SMS") {
    return {
      subject: null,
      body: [`${input.locationName}: ${core}`, manage, call, SMS_OPT_OUT].filter(Boolean).join(" "),
    };
  }

  const lines = [
    `Hi ${input.guestName},`,
    "",
    core,
    ...(manage ? ["", manage] : []),
    ...(call ? ["", call] : []),
    "",
    input.locationName,
    ...(input.locationPhone ? [input.locationPhone] : []),
    ...(input.unsubscribeUrl ? ["", `Stop emails about this booking: ${input.unsubscribeUrl}`] : []),
  ];

  return { subject: `${input.locationName}: ${SUBJECTS[input.kind]}`, body: lines.join("\n") };
}
