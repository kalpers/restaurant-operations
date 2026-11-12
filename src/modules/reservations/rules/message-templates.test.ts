import { describe, expect, it } from "vitest";

import { GUEST_MESSAGE_KINDS } from "@/db/schema/guest-messaging";

import { formatMessageTime, renderGuestMessage, type MessageTemplateInput } from "./message-templates";

const base: MessageTemplateInput = {
  kind: "RESERVATION_CONFIRMED",
  channel: "SMS",
  locationName: "Harbor Grill",
  locationPhone: "(555) 010-2000",
  timeZone: "America/Detroit",
  at: new Date("2026-11-20T23:00:00Z"),
  partySize: 4,
  guestName: "Ana Guest",
  manageUrl: "https://example.test/book/manage/TOKEN",
  unsubscribeUrl: "https://example.test/messages/unsubscribe/UNSUB",
};

describe("message templates (Phase 22 D4)", () => {
  it("formats the time in the location's time zone", () => {
    expect(formatMessageTime(base.at!, "America/Detroit")).toBe("Fri, Nov 20 at 6:00 PM");
    expect(formatMessageTime(base.at!, "America/Los_Angeles")).toBe("Fri, Nov 20 at 3:00 PM");
  });

  it("renders a confirmation text with the manage link and the opt-out line", () => {
    expect(renderGuestMessage(base)).toEqual({
      subject: null,
      body: "Harbor Grill: Your reservation for 4 guests on Fri, Nov 20 at 6:00 PM is confirmed. View or cancel: https://example.test/book/manage/TOKEN Reply STOP to opt out.",
    });
  });

  it("renders an email with a greeting, the location and the unsubscribe link", () => {
    const email = renderGuestMessage({ ...base, channel: "EMAIL" });

    expect(email.subject).toBe("Harbor Grill: Your reservation is confirmed");
    expect(email.body.split("\n")).toEqual([
      "Hi Ana Guest,",
      "",
      "Your reservation for 4 guests on Fri, Nov 20 at 6:00 PM is confirmed.",
      "",
      "View or cancel: https://example.test/book/manage/TOKEN",
      "",
      "Harbor Grill",
      "(555) 010-2000",
      "",
      "Stop emails about this booking: https://example.test/messages/unsubscribe/UNSUB",
    ]);
  });

  it("gives a cancellation the phone number and no manage link", () => {
    const cancelled = renderGuestMessage({ ...base, kind: "RESERVATION_CANCELLED", manageUrl: null });

    expect(cancelled.body).toBe(
      "Harbor Grill: Your reservation for 4 guests on Fri, Nov 20 at 6:00 PM is cancelled. Questions? Call (555) 010-2000. Reply STOP to opt out.",
    );
  });

  it("renders every kind, and the table-ready text needs no time", () => {
    for (const kind of GUEST_MESSAGE_KINDS) {
      const rendered = renderGuestMessage({ ...base, kind, at: kind === "WAITLIST_TABLE_READY" ? null : base.at });

      expect(rendered.body.length).toBeGreaterThan(20);
    }

    expect(renderGuestMessage({ ...base, kind: "WAITLIST_TABLE_READY", at: null, manageUrl: null, partySize: 1 }).body).toBe(
      "Harbor Grill: Your table is ready. Please come to the host stand. Reply STOP to opt out.",
    );
  });

  it("uses the singular for one guest", () => {
    expect(renderGuestMessage({ ...base, partySize: 1 }).body).toContain("for 1 guest on");
  });
});
