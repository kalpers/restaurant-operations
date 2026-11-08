import { describe, expect, it } from "vitest";

import {
  intervalsOverlap,
  planPriceChange,
  resolvePrice,
  type PriceRow,
} from "./price-resolution";

const LOCATION = "loc-1";
const OTHER = "loc-2";
const t = (iso: string) => new Date(iso);

const row = (
  price: string,
  from: string,
  to: string | null,
  locationId: string | null = null,
): PriceRow => ({
  price,
  locationId,
  effectiveFrom: t(from),
  effectiveTo: to ? t(to) : null,
});

describe("resolvePrice", () => {
  const jan = row("12.99", "2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z");
  const jun = row("13.99", "2026-06-01T00:00:00Z", null);

  it("uses the organization default price in force", () => {
    expect(resolvePrice([jan, jun], LOCATION, t("2026-03-01T00:00:00Z"))).toEqual({
      price: "12.99",
      scope: "ORGANIZATION",
    });
  });

  it("prefers a location price over the default", () => {
    const local = row("15.50", "2026-01-01T00:00:00Z", null, LOCATION);

    expect(resolvePrice([jan, jun, local], LOCATION, t("2026-07-01T00:00:00Z"))).toEqual({
      price: "15.50",
      scope: "LOCATION",
    });
  });

  it("ignores another location's price", () => {
    const local = row("15.50", "2026-01-01T00:00:00Z", null, OTHER);

    expect(resolvePrice([jun, local], LOCATION, t("2026-07-01T00:00:00Z"))?.price).toBe("13.99");
  });

  it("falls back to the default when the location price has not started or has ended", () => {
    const future = row("20.00", "2026-09-01T00:00:00Z", null, LOCATION);
    const past = row("9.00", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", LOCATION);

    expect(resolvePrice([jun, future, past], LOCATION, t("2026-07-01T00:00:00Z"))?.scope).toBe(
      "ORGANIZATION",
    );
  });

  it("does not select a future price early or a past price later", () => {
    expect(resolvePrice([jun], LOCATION, t("2026-05-31T23:59:59.999Z"))).toBeNull();
    expect(resolvePrice([jan], LOCATION, t("2026-06-01T00:00:00Z"))).toBeNull();
  });

  it("treats the start as inclusive and the end as exclusive", () => {
    expect(resolvePrice([jan, jun], LOCATION, t("2026-01-01T00:00:00Z"))?.price).toBe("12.99");
    expect(resolvePrice([jan, jun], LOCATION, t("2026-05-31T23:59:59.999Z"))?.price).toBe("12.99");
    expect(resolvePrice([jan, jun], LOCATION, t("2026-06-01T00:00:00Z"))?.price).toBe("13.99");
  });

  it("returns null when no price applies", () => {
    expect(resolvePrice([], LOCATION, t("2026-07-01T00:00:00Z"))).toBeNull();
  });

  it("returns the exact decimal string unchanged", () => {
    const rows = [row("0.10", "2026-01-01T00:00:00Z", null)];

    expect(resolvePrice(rows, LOCATION, t("2026-02-01T00:00:00Z"))?.price).toBe("0.10");
  });

  it("refuses overlapping prices in one scope instead of guessing", () => {
    const a = row("1.00", "2026-01-01T00:00:00Z", null);
    const b = row("2.00", "2026-02-01T00:00:00Z", null);

    expect(() => resolvePrice([a, b], LOCATION, t("2026-03-01T00:00:00Z"))).toThrow(
      /More than one price/,
    );
  });
});

describe("intervalsOverlap", () => {
  it("is half-open: adjacent intervals do not overlap", () => {
    expect(
      intervalsOverlap(
        { from: t("2026-01-01T00:00:00Z"), to: t("2026-02-01T00:00:00Z") },
        { from: t("2026-02-01T00:00:00Z"), to: null },
      ),
    ).toBe(false);
  });

  it("detects overlap with an open-ended interval", () => {
    expect(
      intervalsOverlap(
        { from: t("2026-01-01T00:00:00Z"), to: null },
        { from: t("2026-02-01T00:00:00Z"), to: t("2026-03-01T00:00:00Z") },
      ),
    ).toBe(true);
  });
});

describe("planPriceChange", () => {
  const open = row("12.99", "2026-01-01T00:00:00Z", null);

  it("closes the open price at the new start", () => {
    expect(planPriceChange([open], t("2026-06-01T00:00:00Z"))).toEqual({
      close: { index: 0, at: t("2026-06-01T00:00:00Z") },
    });
  });

  it("needs nothing closed for a first price", () => {
    expect(planPriceChange([], t("2026-06-01T00:00:00Z"))).toEqual({ close: null });
  });

  it("refuses a new price starting when the current one starts", () => {
    expect(planPriceChange([open], t("2026-01-01T00:00:00Z"))).toEqual({
      conflict: "NOT_AFTER_CURRENT",
    });
  });

  it("refuses to jump ahead of a price already queued", () => {
    const queued = row("14.99", "2026-09-01T00:00:00Z", null);
    const current = row("12.99", "2026-01-01T00:00:00Z", "2026-09-01T00:00:00Z");

    expect(planPriceChange([current, queued], t("2026-06-01T00:00:00Z"))).toEqual({
      conflict: "FUTURE_PRICE_EXISTS",
    });
  });
});
