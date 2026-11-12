import { getMessagingConfig, type MessagingConfig } from "@/config/messaging-env";

import { CaptureSender } from "./capture-sender";
import type { MessageChannel, MessageSender } from "./message-sender";
import { SmtpSender } from "./smtp-sender";
import { TwilioSender } from "./twilio-sender";

export type MessageSenders = Record<MessageChannel, MessageSender | null>;

/** The one place that picks an adapter per channel (policy 1). Null means the channel is off. */
export function createMessageSenders(config: MessagingConfig): MessageSenders {
  const capture = new CaptureSender(config.capturePath);
  const { email, sms } = config;

  return {
    EMAIL:
      email.provider === "off"
        ? null
        : email.provider === "smtp"
          ? new SmtpSender(email.smtpUrl!, email.from!, new URL(config.appBaseUrl).hostname)
          : capture,
    SMS: sms.provider === "off" ? null : sms.provider === "twilio" ? new TwilioSender(sms.twilio!) : capture,
  };
}

let senders: MessageSenders | undefined;

export function getMessageSenders(): MessageSenders {
  senders ??= createMessageSenders(getMessagingConfig());

  return senders;
}

/** The channels that can carry messages. Queueing skips a channel that is off. */
export function enabledChannels(config: MessagingConfig = getMessagingConfig()): readonly MessageChannel[] {
  return [
    ...(config.email.provider === "off" ? [] : (["EMAIL"] as const)),
    ...(config.sms.provider === "off" ? [] : (["SMS"] as const)),
  ];
}

export * from "./message-sender";
