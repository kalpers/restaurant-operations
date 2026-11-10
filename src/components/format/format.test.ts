import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { formatMoney, formatMoneyChange, formatQuantity } from "./money";
import { humanizeCode, knownStatuses, statusLabel, statusTone, type StatusDomain } from "./status-labels";

describe("formatMoney", () => {
  it("adds the symbol and thousands separators", () => {
    expect(formatMoney("1234.50")).toBe("$1,234.50");
    expect(formatMoney("1000000.00")).toBe("$1,000,000.00");
    expect(formatMoney("999.99")).toBe("$999.99");
  });

  it("keeps zero and the exact digits it was given", () => {
    expect(formatMoney("0.00")).toBe("$0.00");
    expect(formatMoney("12.3")).toBe("$12.3");
    expect(formatMoney("7")).toBe("$7");
  });

  it("puts the sign before the symbol", () => {
    expect(formatMoney("-3.00")).toBe("-$3.00");
    expect(formatMoney("-12345.67")).toBe("-$12,345.67");
  });

  it("returns anything that isn't a decimal string unchanged", () => {
    expect(formatMoney("")).toBe("");
    expect(formatMoney("abc")).toBe("abc");
    expect(formatMoney("1e5")).toBe("1e5");
  });

  it("never turns money into a JavaScript number", () => {
    const source = readFileSync(join(__dirname, "money.ts"), "utf8");

    expect(source).not.toMatch(/\bNumber\(|parseFloat|parseInt|toFixed|Intl\./);
  });

  it("keeps digits beyond double precision", () => {
    expect(formatMoney("90071992547409931.01")).toBe("$90,071,992,547,409,931.01");
  });
});

describe("formatMoneyChange", () => {
  it("signs a change", () => {
    expect(formatMoneyChange("12.00")).toBe("+$12.00");
    expect(formatMoneyChange("-3.50")).toBe("-$3.50");
    expect(formatMoneyChange("0.00")).toBe("$0.00");
  });
});

describe("formatQuantity", () => {
  it("trims trailing zeros and adds the unit", () => {
    expect(formatQuantity("12.5000", "lb")).toBe("12.5 lb");
    expect(formatQuantity("3.0000")).toBe("3");
    expect(formatQuantity("1500.2500", "oz")).toBe("1,500.25 oz");
    expect(formatQuantity(null)).toBe("—");
  });
});

describe("status labels", () => {
  const domains: StatusDomain[] = [
    "order",
    "orderItem",
    "fulfillment",
    "settlement",
    "tender",
    "tableAvailability",
    "tableSession",
    "reservation",
    "waitlist",
    "schedulePeriod",
    "generationRun",
    "timeOff",
    "swap",
    "purchaseOrder",
    "inventoryCount",
    "employee",
    "recipeRevision",
  ];

  it.each(domains)("gives every known %s status a readable label", (domain) => {
    for (const status of knownStatuses(domain)) {
      expect(statusLabel(domain, status)).not.toMatch(/_|^[A-Z]{2,}$/);
    }
  });

  it("maps statuses to human labels and tones", () => {
    expect(statusLabel("fulfillment", "PREPARING")).toBe("Preparing");
    expect(statusTone("fulfillment", "PREPARING")).toBe("warning");
    expect(statusLabel("reservation", "NO_SHOW")).toBe("No-show");
    expect(statusLabel("tableAvailability", "OUT_OF_SERVICE")).toBe("Out of service");
    expect(statusTone("order", "CLOSED")).toBe("success");
  });

  it("falls back to the humanized raw value for an unknown status", () => {
    expect(statusLabel("order", "ON_HOLD")).toBe("On hold");
    expect(statusTone("order", "ON_HOLD")).toBe("neutral");
    expect(humanizeCode("FULL_TIME")).toBe("Full time");
  });

  it("matches the statuses the schema allows", () => {
    expect(knownStatuses("fulfillment").sort()).toEqual(["CANCELLED", "COMPLETED", "NEW", "PREPARING", "READY"]);
    expect(knownStatuses("swap").sort()).toEqual(["ACCEPTED", "CANCELLED", "COMPLETED", "DENIED", "PENDING"]);
    expect(knownStatuses("generationRun").sort()).toEqual(["COMPLETED", "FAILED", "STARTED"]);
  });
});
