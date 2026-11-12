import nodemailer, { type Transporter } from "nodemailer";

import {
  failureCode,
  PROVIDER_TIMEOUT_MS,
  type MessageSender,
  type OutboundMessage,
  type SendFailure,
  type SendResult,
} from "./message-sender";

// SMTP email adapter (policy 1). The one module that imports nodemailer (DEV-004 controls):
// plain text only, with no raw message, attachments, file or URL content, or caller headers.

type SmtpError = { code?: unknown; responseCode?: unknown };

/** 4xx replies and connection problems are retried; 5xx replies and envelope errors aren't. */
export function classifySmtpError(error: unknown): SendFailure {
  const { code, responseCode } = (error ?? {}) as SmtpError;

  if (typeof responseCode === "number") {
    return {
      ok: false,
      kind: responseCode >= 500 ? "PERMANENT" : "TRANSIENT",
      code: failureCode(`smtp:${responseCode}`),
    };
  }

  const name = typeof code === "string" ? code : "ERROR";

  if (name === "EENVELOPE" || name === "EMESSAGE") {
    return { ok: false, kind: "PERMANENT", code: failureCode(`smtp:${name}`) };
  }

  return { ok: false, kind: "TRANSIENT", code: failureCode(`smtp:${name}`) };
}

export class SmtpSender implements MessageSender {
  readonly name = "smtp";
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
    /** The Message-ID's domain. */
    private readonly messageIdDomain: string,
  ) {
    this.transport = nodemailer.createTransport({
      url: smtpUrl,
      connectionTimeout: PROVIDER_TIMEOUT_MS,
      greetingTimeout: PROVIDER_TIMEOUT_MS,
      socketTimeout: PROVIDER_TIMEOUT_MS,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    // Built from the row ID, so a repeat after a crash carries the same Message-ID (D3).
    const messageId = `<${message.id}@${this.messageIdDomain}>`;

    try {
      await this.transport.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject ?? "",
        text: message.body,
        messageId,
        disableFileAccess: true,
        disableUrlAccess: true,
      });

      return { ok: true, providerMessageId: messageId };
    } catch (error) {
      return classifySmtpError(error);
    }
  }
}
