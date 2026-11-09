import { describe, expect, it } from "vitest";

import type { KitchenItemStatus } from "../types";
import {
  ageBand,
  compareQueue,
  deriveTicketStatus,
  groupByStation,
  planTransition,
  planVoidCancellation,
} from "./fulfillment-rules";

describe("fulfillment lifecycle", () => {
  it("allows only NEW -> PREPARING -> READY -> COMPLETED", () => {
    expect(planTransition("NEW", "start")).toEqual({ kind: "apply", from: "NEW", to: "PREPARING" });
    expect(planTransition("PREPARING", "ready")).toEqual({
      kind: "apply",
      from: "PREPARING",
      to: "READY",
    });
    expect(planTransition("READY", "complete")).toEqual({
      kind: "apply",
      from: "READY",
      to: "COMPLETED",
    });
  });

  it("rejects NEW -> READY and NEW -> COMPLETED", () => {
    expect(() => planTransition("NEW", "ready")).toThrow(
      expect.objectContaining({ code: "FULFILLMENT_INVALID_TRANSITION" }),
    );
    expect(() => planTransition("NEW", "complete")).toThrow(
      expect.objectContaining({ code: "FULFILLMENT_INVALID_TRANSITION" }),
    );
  });

  it("rejects going backward (no recall)", () => {
    expect(() => planTransition("READY", "start")).toThrow(
      expect.objectContaining({ code: "FULFILLMENT_INVALID_TRANSITION" }),
    );
  });

  it("keeps COMPLETED and CANCELLED terminal", () => {
    for (const action of ["start", "ready"] as const) {
      expect(() => planTransition("COMPLETED", action)).toThrow(
        expect.objectContaining({ code: "FULFILLMENT_ITEM_TERMINAL" }),
      );
    }

    for (const action of ["start", "ready", "complete"] as const) {
      expect(() => planTransition("CANCELLED", action)).toThrow(
        expect.objectContaining({ code: "FULFILLMENT_ITEM_CANCELLED" }),
      );
    }
  });

  it("treats a repeated action as already done", () => {
    expect(planTransition("PREPARING", "start")).toEqual({ kind: "already", to: "PREPARING" });
    expect(planTransition("READY", "ready")).toEqual({ kind: "already", to: "READY" });
    expect(planTransition("COMPLETED", "complete")).toEqual({ kind: "already", to: "COMPLETED" });
  });
});

describe("ticket status aggregation", () => {
  const cases: [KitchenItemStatus[], KitchenItemStatus][] = [
    [["NEW", "NEW"], "NEW"],
    [["NEW", "PREPARING"], "PREPARING"],
    [["READY", "NEW"], "NEW"],
    [["READY", "PREPARING"], "PREPARING"],
    [["READY", "READY"], "READY"],
    [["READY", "COMPLETED"], "READY"],
    [["READY", "CANCELLED"], "READY"],
    [["NEW", "CANCELLED"], "NEW"],
    [["PREPARING", "CANCELLED"], "PREPARING"],
    [["CANCELLED", "CANCELLED"], "CANCELLED"],
    [["COMPLETED", "CANCELLED"], "COMPLETED"],
    [["COMPLETED", "COMPLETED"], "COMPLETED"],
    [["COMPLETED", "NEW"], "NEW"],
    [["COMPLETED", "PREPARING"], "PREPARING"],
  ];

  it.each(cases)("%j -> %s", (statuses, expected) => {
    expect(deriveTicketStatus(statuses)).toBe(expected);
  });
});

describe("void compatibility", () => {
  const items = (statuses: KitchenItemStatus[]) =>
    statuses.map((status, index) => ({ id: `i${index}`, status }));

  it("allows UNPREPARED only when every attempt is NEW, and cancels all", () => {
    expect(planVoidCancellation(items(["NEW", "NEW"]), "UNPREPARED")).toEqual({
      cancelIds: ["i0", "i1"],
    });
  });

  it.each([["PREPARING"], ["READY"], ["COMPLETED"]] as const)(
    "refuses UNPREPARED when an attempt is %s",
    (status) => {
      expect(() => planVoidCancellation(items(["NEW", status]), "UNPREPARED")).toThrow(
        expect.objectContaining({ code: "FULFILLMENT_ALREADY_STARTED" }),
      );
    },
  );

  it("PREPARED_OR_DISCARDED cancels active work and keeps terminal history", () => {
    expect(
      planVoidCancellation(
        items(["NEW", "PREPARING", "READY", "COMPLETED", "CANCELLED"]),
        "PREPARED_OR_DISCARDED",
      ),
    ).toEqual({ cancelIds: ["i0", "i1", "i2"] });
  });

  it("an item with no station work can be voided either way", () => {
    expect(planVoidCancellation([], "UNPREPARED")).toEqual({ cancelIds: [] });
  });
});

describe("queue ordering", () => {
  it("is FIFO by submission, then ticket ID, then item ID", () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 9, 18, minute));
    const rows = [
      { id: "b", ticketId: "t2", submittedAt: at(1) },
      { id: "c", ticketId: "t1", submittedAt: at(1) },
      { id: "a", ticketId: "t1", submittedAt: at(1) },
      { id: "z", ticketId: "t9", submittedAt: at(0) },
    ];

    expect([...rows].sort(compareQueue).map((row) => row.id)).toEqual(["z", "a", "c", "b"]);
    expect([...rows].reverse().sort(compareQueue).map((row) => row.id)).toEqual(["z", "a", "c", "b"]);
  });
});

describe("station grouping", () => {
  const types = new Map([
    ["grill", "KITCHEN"],
    ["fry", "KITCHEN"],
    ["bar", "BAR"],
    ["expo", "EXPO"],
  ] as const);

  it("makes one group per station, with multi-station items in each", () => {
    const burger = { id: "burger", prepStationIds: ["grill"] };
    const combo = { id: "combo", prepStationIds: ["grill", "fry"] };
    const cocktail = { id: "cocktail", prepStationIds: ["bar"] };
    const groups = groupByStation([burger, combo, cocktail], types);

    expect([...groups.keys()]).toEqual(["grill", "fry", "bar"]);
    expect(groups.get("grill")!.map((item) => item.id)).toEqual(["burger", "combo"]);
    expect(groups.get("fry")!.map((item) => item.id)).toEqual(["combo"]);
  });

  it("skips EXPO and creates nothing for an empty route", () => {
    const groups = groupByStation(
      [
        { id: "a", prepStationIds: ["expo"] },
        { id: "b", prepStationIds: [] },
      ],
      types,
    );

    expect(groups.size).toBe(0);
  });

  it("refuses an unknown station", () => {
    expect(() => groupByStation([{ id: "a", prepStationIds: ["ghost"] }], types)).toThrow(
      expect.objectContaining({ code: "PREP_STATION_NOT_FOUND" }),
    );
  });
});

describe("age bands", () => {
  it("are display-only thresholds", () => {
    const now = new Date(Date.UTC(2026, 10, 9, 19, 0));
    const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

    expect(ageBand(minutesAgo(9), now)).toBe("normal");
    expect(ageBand(minutesAgo(10), now)).toBe("warning");
    expect(ageBand(minutesAgo(20), now)).toBe("late");
  });
});
