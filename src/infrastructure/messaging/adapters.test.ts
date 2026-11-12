import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { resolveCapturePath } from "@/config/messaging-env";

import { CaptureSender } from "./capture-sender";
import { failureCode, PROVIDER_TIMEOUT_MS } from "./message-sender";
import { classifySmtpError } from "./smtp-sender";
import { classifyTwilioResponse, TwilioSender } from "./twilio-sender";

const message = { id: "7d1b5b1e-3c39-4d55-9a8f-2b2f8b3f1a10", channel: "SMS" as const, to: "+15551234567", subject: null, body: "Your table is ready." };

describe("failureCode", () => {
  it("keeps only identifier characters and at most 60 of them", () => {
    expect(failureCode("smtp:550 mailbox <guest@example.com> unknown")).toBe("smtp:550mailboxguestexample.comunknown");
    expect(failureCode("x".repeat(80))).toHaveLength(60);
    expect(failureCode("!!!")).toBe("UNKNOWN");
  });
});

describe("SMTP error classification (policy 1)", () => {
  it("retries 4xx replies and connection errors", () => {
    expect(classifySmtpError({ responseCode: 421 })).toMatchObject({ kind: "TRANSIENT", code: "smtp:421" });
    expect(classifySmtpError({ code: "ETIMEDOUT" })).toMatchObject({ kind: "TRANSIENT", code: "smtp:ETIMEDOUT" });
    expect(classifySmtpError({ code: "EAUTH" })).toMatchObject({ kind: "TRANSIENT" });
    expect(classifySmtpError(new Error("boom"))).toMatchObject({ kind: "TRANSIENT", code: "smtp:ERROR" });
  });

  it("fails 5xx replies and envelope errors for good", () => {
    expect(classifySmtpError({ responseCode: 550 })).toMatchObject({ kind: "PERMANENT", code: "smtp:550" });
    expect(classifySmtpError({ code: "EENVELOPE" })).toMatchObject({ kind: "PERMANENT" });
  });
});

describe("Twilio adapter (policy 1)", () => {
  const settings = { accountSid: `AC${"a".repeat(32)}`, authToken: "token-value-12345678", from: "+15550000000" };

  it("classifies opt-outs, retryable and permanent responses", () => {
    expect(classifyTwilioResponse(400, 21610)).toMatchObject({ kind: "OPTED_OUT", code: "twilio:400:21610" });
    expect(classifyTwilioResponse(429, null)).toMatchObject({ kind: "TRANSIENT" });
    expect(classifyTwilioResponse(503, null)).toMatchObject({ kind: "TRANSIENT" });
    expect(classifyTwilioResponse(401, 20003)).toMatchObject({ kind: "TRANSIENT" });
    expect(classifyTwilioResponse(400, 21211)).toMatchObject({ kind: "PERMANENT" });
  });

  it("posts the message form with basic auth and a timeout, and returns the SID", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ sid: "SM123" }), { status: 201 }));
    const result = await new TwilioSender(settings, fetcher as unknown as typeof fetch).send(message);

    expect(result).toEqual({ ok: true, providerMessageId: "SM123" });

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const form = new URLSearchParams(init.body as URLSearchParams);

    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${settings.accountSid}/Messages.json`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from(`${settings.accountSid}:${settings.authToken}`).toString("base64")}`,
    );
    expect(Object.fromEntries(form)).toEqual({ To: "+15551234567", From: "+15550000000", Body: "Your table is ready." });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(PROVIDER_TIMEOUT_MS).toBe(10_000);
  });

  it("turns a Twilio error body into a classified failure without provider text", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ code: 21610, message: "Attempt to send to unsubscribed recipient +15551234567" }), { status: 400 }),
    );
    const result = await new TwilioSender(settings, fetcher as unknown as typeof fetch).send(message);

    expect(result).toEqual({ ok: false, kind: "OPTED_OUT", code: "twilio:400:21610" });
  });

  it("treats a network failure or timeout as transient", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const fetcher = vi.fn(async () => {
      throw timeout;
    });

    expect(await new TwilioSender(settings, fetcher as unknown as typeof fetch).send(message)).toEqual({
      ok: false,
      kind: "TRANSIENT",
      code: "twilio:TimeoutError",
    });
  });
});

describe("capture adapter (policy 1)", () => {
  let folder: string | undefined;

  afterAll(async () => {
    if (folder) {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("writes the message as JSON and sends nothing", async () => {
    folder = await mkdtemp(path.join(tmpdir(), "restaurant-ops-capture-"));

    const result = await new CaptureSender(folder).send(message);
    const written = JSON.parse(await readFile(path.join(folder, `sms-${message.id}.json`), "utf8"));

    expect(result).toEqual({ ok: true, providerMessageId: `capture-${message.id}` });
    expect(written).toMatchObject({ id: message.id, to: "+15551234567", body: "Your table is ready." });
  });

  it("refuses a capture folder inside public/", () => {
    expect(() => resolveCapturePath("public/messages", "/project")).toThrow("outside the public directory");
    expect(resolveCapturePath(".local/outbound-messages", "/project")).toBe(path.resolve("/project", ".local/outbound-messages"));
  });
});
