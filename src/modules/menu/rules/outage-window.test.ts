import { describe, expect, it } from "vitest";

import { outagePhase, resolveOutageWindow } from "./outage-window";

const settings = { timeZone: "America/Chicago", businessDayCutoff: "04:00" };
const now = new Date("2026-11-11T20:00:00.000Z"); // 2:00 PM in Chicago

describe("resolveOutageWindow", () => {
  it("starts now with no end by default", () => {
    expect(resolveOutageWindow({}, now, settings)).toEqual({ startsAt: now, endsAt: null });
  });

  it("schedules a later start, such as 9 PM", () => {
    const nine = new Date("2026-11-12T03:00:00.000Z");

    expect(resolveOutageWindow({ startsAt: nine }, now, settings).startsAt).toEqual(nine);
  });

  it("ends at the next business-date cutoff for \"until close\"", () => {
    expect(resolveOutageWindow({ untilClose: true }, now, settings).endsAt).toEqual(
      new Date("2026-11-12T10:00:00.000Z"),
    );
  });

  it("uses the business date of the start, so after midnight still ends at 4 AM", () => {
    const oneAm = new Date("2026-11-12T07:00:00.000Z");

    expect(resolveOutageWindow({ startsAt: oneAm, untilClose: true }, now, settings).endsAt).toEqual(
      new Date("2026-11-12T10:00:00.000Z"),
    );
  });

  it("takes a start a few seconds ago as now, and refuses one well in the past", () => {
    expect(resolveOutageWindow({ startsAt: new Date(now.getTime() - 5000) }, now, settings).startsAt).toEqual(now);
    expect(() => resolveOutageWindow({ startsAt: new Date(now.getTime() - 120_000) }, now, settings)).toThrow(
      /past/,
    );
  });

  it("refuses an end at or before the start, and both end kinds at once", () => {
    expect(() => resolveOutageWindow({ endsAt: now }, now, settings)).toThrow(/after it starts/);
    expect(() =>
      resolveOutageWindow({ endsAt: new Date(now.getTime() + 1000), untilClose: true }, now, settings),
    ).toThrow(/not both/);
  });
});

describe("outagePhase", () => {
  const window = { startsAt: new Date("2026-11-11T21:00:00.000Z"), endsAt: new Date("2026-11-11T23:00:00.000Z") };

  it("is scheduled before the start, in effect inside, and ended at the end", () => {
    expect(outagePhase(window, now)).toBe("SCHEDULED");
    expect(outagePhase(window, new Date("2026-11-11T21:00:00.000Z"))).toBe("IN_EFFECT");
    expect(outagePhase(window, new Date("2026-11-11T23:00:00.000Z"))).toBe("ENDED");
    expect(outagePhase({ startsAt: now, endsAt: null }, new Date("2030-01-01T00:00:00.000Z"))).toBe("IN_EFFECT");
  });
});
