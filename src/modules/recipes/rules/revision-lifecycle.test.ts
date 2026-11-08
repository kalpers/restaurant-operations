import { describe, expect, it } from "vitest";

import {
  assertEditable,
  nextRevisionNumber,
  normalizeYield,
  planPublish,
  planRetire,
  resolveRevisionAt,
  type RevisionRow,
} from "./revision-lifecycle";

const t = (iso: string) => new Date(iso);
const NOW = t("2026-06-01T12:00:00Z");

const rev = (
  id: string,
  revisionNumber: number,
  status: RevisionRow["status"],
  from: string | null,
  to: string | null = null,
): RevisionRow => ({
  id,
  revisionNumber,
  status,
  effectiveFrom: from ? t(from) : null,
  effectiveTo: to ? t(to) : null,
});

describe("yield", () => {
  it("is positive and exact to four places", () => {
    expect(normalizeYield("1")).toBe("1.0000");
    expect(normalizeYield("64.5")).toBe("64.5000");
    expect(() => normalizeYield("0")).toThrow(/greater than zero/);
    expect(() => normalizeYield("-1")).toThrow(/greater than zero/);
    expect(() => normalizeYield("1.00001")).toThrow(/four decimal/);
    expect(() => normalizeYield("lots")).toThrow(/four decimal/);
  });
});

describe("revision numbering", () => {
  it("increases monotonically from 1", () => {
    expect(nextRevisionNumber([])).toBe(1);
    expect(
      nextRevisionNumber([rev("a", 1, "RETIRED", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"), rev("b", 2, "DRAFT", null)]),
    ).toBe(3);
  });
});

describe("editing", () => {
  it("allows only drafts", () => {
    expect(() => assertEditable("DRAFT")).not.toThrow();
    expect(() => assertEditable("PUBLISHED")).toThrow(/Only a draft/);
    expect(() => assertEditable("RETIRED")).toThrow(/Only a draft/);
  });
});

describe("planPublish", () => {
  const draft = rev("d", 2, "DRAFT", null);

  it("publishes the first revision from now with nothing to close", () => {
    expect(planPublish([rev("d", 1, "DRAFT", null)], rev("d", 1, "DRAFT", null), null, NOW)).toEqual({
      effectiveFrom: NOW,
      closePrior: null,
    });
  });

  it("closes the prior revision where the new one begins", () => {
    const prior = rev("p", 1, "PUBLISHED", "2026-01-01T00:00:00Z");
    const plan = planPublish([prior, draft], draft, null, NOW);

    expect(plan.closePrior).toEqual({ id: "p", at: NOW });
    expect(plan.effectiveFrom).toEqual(NOW);
  });

  it("supports a future start, leaving the prior revision in force until then", () => {
    const prior = rev("p", 1, "PUBLISHED", "2026-01-01T00:00:00Z");
    const later = t("2026-07-01T00:00:00Z");

    expect(planPublish([prior, draft], draft, later, NOW)).toEqual({
      effectiveFrom: later,
      closePrior: { id: "p", at: later },
    });
  });

  it("refuses a start in the past", () => {
    expect(() => planPublish([draft], draft, t("2026-05-31T00:00:00Z"), NOW)).toThrow(/past/);
  });

  it("refuses a start that is not after every earlier revision", () => {
    const prior = rev("p", 1, "PUBLISHED", "2026-09-01T00:00:00Z");

    expect(() => planPublish([prior, draft], draft, t("2026-08-01T00:00:00Z"), NOW)).toThrow(
      /after every earlier/,
    );
    expect(() => planPublish([prior, draft], draft, t("2026-09-01T00:00:00Z"), NOW)).toThrow(
      /after every earlier/,
    );
  });

  it("does not close a revision that already ended", () => {
    const ended = rev("p", 1, "PUBLISHED", "2026-01-01T00:00:00Z", "2026-05-01T00:00:00Z");

    expect(planPublish([ended, draft], draft, null, NOW).closePrior).toBeNull();
  });

  it("refuses to publish a revision that is not a draft", () => {
    const published = rev("p", 1, "PUBLISHED", "2026-01-01T00:00:00Z");

    expect(() => planPublish([published], published, null, NOW)).toThrow(/Only a draft/);
  });
});

describe("planRetire", () => {
  it("ends an effective revision now", () => {
    expect(planRetire(rev("p", 1, "PUBLISHED", "2026-01-01T00:00:00Z"), NOW)).toEqual({
      effectiveTo: NOW,
    });
  });

  it("gives a revision that never took effect an empty interval", () => {
    const future = rev("p", 1, "PUBLISHED", "2026-07-01T00:00:00Z");

    expect(planRetire(future, NOW)).toEqual({ effectiveTo: future.effectiveFrom });
  });

  it("keeps an interval that has already closed", () => {
    const ended = rev("p", 1, "PUBLISHED", "2026-01-01T00:00:00Z", "2026-05-01T00:00:00Z");

    expect(planRetire(ended, NOW)).toEqual({ effectiveTo: ended.effectiveTo });
  });

  it("refuses anything that is not published", () => {
    expect(() => planRetire(rev("d", 1, "DRAFT", null), NOW)).toThrow(/Only a published/);
    expect(() =>
      planRetire(rev("r", 1, "RETIRED", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"), NOW),
    ).toThrow(/Only a published/);
  });
});

describe("resolveRevisionAt", () => {
  const first = rev("1", 1, "PUBLISHED", "2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z");
  const second = rev("2", 2, "PUBLISHED", "2026-06-01T00:00:00Z");
  const draft = rev("3", 3, "DRAFT", null);

  it("finds the revision in effect, with a half-open boundary", () => {
    expect(resolveRevisionAt([first, second, draft], t("2026-05-31T23:59:59.999Z"))?.id).toBe("1");
    expect(resolveRevisionAt([first, second, draft], t("2026-06-01T00:00:00Z"))?.id).toBe("2");
  });

  it("returns null before the first revision and never a draft", () => {
    expect(resolveRevisionAt([first, second, draft], t("2025-12-31T23:59:59Z"))).toBeNull();
    expect(resolveRevisionAt([draft], NOW)).toBeNull();
  });

  it("still resolves a retired revision for the time it was in effect", () => {
    const retired = rev("r", 1, "RETIRED", "2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z");

    expect(resolveRevisionAt([retired], t("2026-02-01T00:00:00Z"))?.id).toBe("r");
    expect(resolveRevisionAt([retired], t("2026-03-01T00:00:00Z"))).toBeNull();
  });

  it("ignores a revision retired before it took effect", () => {
    const never = rev("n", 1, "RETIRED", "2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z");

    expect(resolveRevisionAt([never], t("2026-07-01T00:00:00Z"))).toBeNull();
  });
});
