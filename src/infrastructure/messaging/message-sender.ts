// Phase 22 outbound messaging port (policy 1). Adapters deliver one guest message through a
// provider. They never throw and never log a recipient address or body: every outcome is a
// result the dispatcher records.

export const MESSAGE_CHANNELS = ["EMAIL", "SMS"] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export type OutboundMessage = {
  /** The `guest_messages` row ID. Adapters derive provider identifiers from it. */
  id: string;
  channel: MessageChannel;
  to: string;
  /** Email only. */
  subject: string | null;
  body: string;
};

/**
 * TRANSIENT: try again later (timeouts, throttling, provider outages, credentials an operator
 * can fix). PERMANENT: this message can never be delivered (a refused address).
 * OPTED_OUT: the provider says the recipient opted out (Twilio 21610).
 */
export type SendFailureKind = "TRANSIENT" | "PERMANENT" | "OPTED_OUT";

export type SendFailure = {
  ok: false;
  kind: SendFailureKind;
  /** Error kind and provider code only, never text from the provider. */
  code: string;
};

export type SendResult = { ok: true; providerMessageId: string } | SendFailure;

export interface MessageSender {
  /** For logs and health: `capture`, `smtp`, `twilio`. */
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
}

/** Provider calls give up after this long; the dispatcher retries later. */
export const PROVIDER_TIMEOUT_MS = 10_000;

/** Keeps a failure code short and free of anything but identifier characters. */
export function failureCode(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 60) || "UNKNOWN";
}
