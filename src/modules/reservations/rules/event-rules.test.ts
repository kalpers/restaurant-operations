import { describe, expect, it } from "vitest";

import { AppError } from "@/shared/errors/app-error";

import {
  assertDepositRecord,
  assertEventOpen,
  assertEventTimes,
  assertEventTransition,
  eventBlockInterval,
  eventBlocks,
  formatEventNumber,
} from "./event-rules";

const codeOf = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return (error as AppError).code;
  }

  return undefined;
};

describe("event rules (Phase 36 policy 7)", () => {
  it("allows the status moves a person may make, never into COMPLETED", () => {
    expect(codeOf(() => assertEventTransition("INQUIRY", "CONFIRMED"))).toBeUndefined();
    expect(codeOf(() => assertEventTransition("TENTATIVE", "INQUIRY"))).toBeUndefined();
    expect(codeOf(() => assertEventTransition("CONFIRMED", "TENTATIVE"))).toBeUndefined();
    expect(codeOf(() => assertEventTransition("CONFIRMED", "COMPLETED"))).toBe("EVENT_STATUS_INVALID");
    expect(codeOf(() => assertEventTransition("CANCELLED", "CONFIRMED"))).toBe("EVENT_STATUS_INVALID");
    expect(codeOf(() => assertEventTransition("CONFIRMED", "INQUIRY"))).toBe("EVENT_STATUS_INVALID");
  });

  it("holds the space only while tentative or confirmed", () => {
    expect(eventBlocks("INQUIRY")).toBe(false);
    expect(eventBlocks("TENTATIVE")).toBe(true);
    expect(eventBlocks("CONFIRMED")).toBe(true);
    expect(eventBlocks("COMPLETED")).toBe(false);
    expect(eventBlocks("CANCELLED")).toBe(false);
    expect(codeOf(() => assertEventOpen("COMPLETED"))).toBe("EVENT_FINISHED");
  });

  it("blocks from setup to teardown, half-open", () => {
    const interval = eventBlockInterval({
      startsAt: new Date("2026-12-31T23:00:00Z"),
      endsAt: new Date("2027-01-01T02:00:00Z"),
      setupMinutes: 60,
      teardownMinutes: 30,
    });

    expect(interval).toEqual({ start: new Date("2026-12-31T22:00:00Z"), end: new Date("2027-01-01T02:30:00Z") });
  });

  it("needs an end after the start within 24 hours, and buffers of 0 to 480 minutes", () => {
    const start = new Date("2026-12-31T23:00:00Z");
    const at = (hours: number) => new Date(start.getTime() + hours * 3_600_000);

    expect(codeOf(() => assertEventTimes({ startsAt: start, endsAt: at(24), setupMinutes: 0, teardownMinutes: 480 }))).toBeUndefined();
    expect(codeOf(() => assertEventTimes({ startsAt: start, endsAt: start, setupMinutes: 0, teardownMinutes: 0 }))).toBe("EVENT_TIMES_INVALID");
    expect(codeOf(() => assertEventTimes({ startsAt: start, endsAt: at(25), setupMinutes: 0, teardownMinutes: 0 }))).toBe("EVENT_TIMES_INVALID");
    expect(codeOf(() => assertEventTimes({ startsAt: start, endsAt: at(2), setupMinutes: 481, teardownMinutes: 0 }))).toBe("EVENT_TIMES_INVALID");
  });

  it("records a deposit as a whole or not at all", () => {
    expect(codeOf(() => assertDepositRecord({ depositReceived: null, depositReceivedOn: null, depositMethod: null }))).toBeUndefined();
    expect(codeOf(() => assertDepositRecord({ depositReceived: "100.00", depositReceivedOn: "2026-11-23", depositMethod: "CASH" }))).toBeUndefined();
    expect(codeOf(() => assertDepositRecord({ depositReceived: "100.00", depositReceivedOn: null, depositMethod: "CASH" }))).toBe(
      "DEPOSIT_INCOMPLETE",
    );
  });

  it("numbers events EV-000123", () => {
    expect(formatEventNumber(123)).toBe("EV-000123");
  });
});
