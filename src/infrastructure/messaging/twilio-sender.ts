import {
  failureCode,
  PROVIDER_TIMEOUT_MS,
  type MessageSender,
  type OutboundMessage,
  type SendFailure,
  type SendResult,
} from "./message-sender";

// Twilio SMS adapter (policy 1): the Messages REST API over fetch, with no SDK.

export type TwilioSettings = { accountSid: string; authToken: string; from: string };

/** Twilio's error for a recipient who replied STOP. */
export const TWILIO_OPTED_OUT_CODE = 21610;

/**
 * 429 and 5xx are retried, as are 401 and 403 (credentials an operator can fix). 21610 is an
 * opt-out. Any other 4xx (a bad number, for example) can't succeed.
 */
export function classifyTwilioResponse(status: number, errorCode: number | null): SendFailure {
  const code = failureCode(`twilio:${status}${errorCode === null ? "" : `:${errorCode}`}`);

  if (errorCode === TWILIO_OPTED_OUT_CODE) {
    return { ok: false, kind: "OPTED_OUT", code };
  }

  if (status === 429 || status >= 500 || status === 401 || status === 403) {
    return { ok: false, kind: "TRANSIENT", code };
  }

  return { ok: false, kind: "PERMANENT", code };
}

export class TwilioSender implements MessageSender {
  readonly name = "twilio";

  constructor(
    private readonly settings: TwilioSettings,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const { accountSid, authToken, from } = this.settings;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;

    try {
      const response = await this.fetcher(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: message.to, From: from, Body: message.body }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => null)) as { sid?: unknown; code?: unknown } | null;

      if (response.ok && typeof body?.sid === "string") {
        return { ok: true, providerMessageId: body.sid };
      }

      return classifyTwilioResponse(response.status, typeof body?.code === "number" ? body.code : null);
    } catch (error) {
      return { ok: false, kind: "TRANSIENT", code: failureCode(`twilio:${error instanceof Error ? error.name : "FetchError"}`) };
    }
  }
}
