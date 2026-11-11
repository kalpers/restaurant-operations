import { describe, expect, it } from "vitest";

import { AppError } from "@/shared/errors/app-error";

import { assertRefundWithinLimits, drawerVariance, expectedCash } from "./drawer-math";

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return error instanceof AppError ? error.code : String(error);
  }

  return undefined;
}

describe("expected drawer cash", () => {
  it("adds float, recorded cash and tips and paid-ins, and takes off paid-outs and refunds", () => {
    const totals = expectedCash({
      openingFloat: "100.00",
      tenders: [
        { status: "RECORDED", amount: "18.93", tipAmount: "3.00" },
        { status: "RECORDED", amount: "4.95", tipAmount: "0.00" },
        { status: "VOIDED", amount: "50.00", tipAmount: "5.00" },
      ],
      movements: [
        { movementType: "PAID_IN", amount: "20.00" },
        { movementType: "PAID_OUT", amount: "12.50" },
      ],
      refunds: [
        { status: "RECORDED", amount: "2.00" },
        { status: "VOIDED", amount: "9.00" },
      ],
    });

    expect(totals).toEqual({
      openingFloat: "100.00",
      cashSales: "23.88",
      cashTips: "3.00",
      paidIn: "20.00",
      paidOut: "12.50",
      cashRefunds: "2.00",
      expected: "132.38",
    });
  });

  it("is just the float for an empty session", () => {
    expect(expectedCash({ openingFloat: "150", tenders: [], movements: [], refunds: [] }).expected).toBe("150.00");
  });

  it("signs the variance: short is negative, over is positive", () => {
    expect(drawerVariance("130.00", "132.38")).toBe("-2.38");
    expect(drawerVariance("133.00", "132.38")).toBe("0.62");
    expect(drawerVariance("132.38", "132.38")).toBe("0.00");
  });
});

describe("refund limits", () => {
  const limits = {
    totalDue: "21.80",
    taxTotal: "1.80",
    existing: [
      { status: "RECORDED", amount: "10.00", taxAmount: "0.80" },
      { status: "VOIDED", amount: "11.80", taxAmount: "1.00" },
    ],
  };

  it("allows up to what's left, ignoring voided refunds", () => {
    expect(assertRefundWithinLimits(limits, "11.80", "1.00")).toEqual({ remaining: "0.00", remainingTax: "0.00" });
  });

  it("refuses more than the order total or its tax", () => {
    expect(codeOf(() => assertRefundWithinLimits(limits, "11.81", "0.00"))).toBe("REFUND_EXCEEDS_ORDER");
    expect(codeOf(() => assertRefundWithinLimits(limits, "5.00", "1.01"))).toBe("REFUND_EXCEEDS_ORDER");
  });

  it("refuses a tax part larger than the refund", () => {
    expect(codeOf(() => assertRefundWithinLimits(limits, "0.50", "0.60"))).toBe("INVALID_REFUND_TAX");
  });
});
