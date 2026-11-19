import { describe, expect, it } from "vitest";

import { AppError } from "@/shared/errors/app-error";

import {
  assertAdjustmentWithinLimits,
  assertCanCashOut,
  assertCardCovers,
  assertCardRefundWithinLimits,
  assertSaleWithinLimits,
  parseSignedMoney,
  saleChange,
} from "./gift-card-math";

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return error instanceof AppError ? error.code : String(error);
  }

  return undefined;
}

describe("gift card sales", () => {
  it("allows 1.00 up to the maximum balance", () => {
    expect(assertSaleWithinLimits("1.00", "0.00", "500.00")).toBe("1.00");
    expect(assertSaleWithinLimits("450.00", "50.00", "500.00")).toBe("500.00");
  });

  it("refuses less than 1.00 and anything over the maximum", () => {
    expect(codeOf(() => assertSaleWithinLimits("0.99", "0.00", "500.00"))).toBe("GIFT_CARD_SALE_TOO_SMALL");
    expect(codeOf(() => assertSaleWithinLimits("450.01", "50.00", "500.00"))).toBe("GIFT_CARD_MAX_BALANCE");
  });

  it("gives change for cash and refuses too little", () => {
    expect(saleChange("50.00", "60.00")).toBe("10.00");
    expect(saleChange("50.00", "50.00")).toBe("0.00");
    expect(codeOf(() => saleChange("50.00", "49.99"))).toBe("INSUFFICIENT_CASH");
  });
});

describe("spending and refunds", () => {
  it("takes no more than the card holds", () => {
    expect(codeOf(() => assertCardCovers("20.00", "20.00"))).toBeUndefined();
    expect(codeOf(() => assertCardCovers("20.01", "20.00"))).toBe("INSUFFICIENT_GIFT_CARD_BALANCE");
  });

  it("refunds onto a card at most what it paid on the check, less its earlier refunds", () => {
    const tenders = [
      { status: "RECORDED", amount: "30.00" },
      { status: "VOIDED", amount: "10.00" },
    ];
    const refunds = [
      { status: "RECORDED", amount: "5.00" },
      { status: "VOIDED", amount: "20.00" },
    ];

    expect(assertCardRefundWithinLimits(tenders, refunds, "25.00")).toBe("0.00");
    expect(codeOf(() => assertCardRefundWithinLimits(tenders, refunds, "25.01"))).toBe("REFUND_EXCEEDS_GIFT_CARD");
  });
});

describe("adjustments and cash-out", () => {
  it("keeps the card between zero and the maximum", () => {
    expect(assertAdjustmentWithinLimits("-5.00", "20.00", "500.00")).toBe("15.00");
    expect(assertAdjustmentWithinLimits("480.00", "20.00", "500.00")).toBe("500.00");
    expect(codeOf(() => assertAdjustmentWithinLimits("-20.01", "20.00", "500.00"))).toBe("INSUFFICIENT_GIFT_CARD_BALANCE");
    expect(codeOf(() => assertAdjustmentWithinLimits("480.01", "20.00", "500.00"))).toBe("GIFT_CARD_MAX_BALANCE");
    expect(codeOf(() => assertAdjustmentWithinLimits("0.00", "20.00", "500.00"))).toBe("INVALID_ADJUSTMENT");
  });

  it("cashes out the whole balance, never an empty card", () => {
    expect(assertCanCashOut("4.75")).toBe("4.75");
    expect(codeOf(() => assertCanCashOut("0.00"))).toBe("GIFT_CARD_EMPTY");
  });

  it("parses signed amounts", () => {
    expect(parseSignedMoney("-5")).toBe("-5.00");
    expect(parseSignedMoney(" 12.5 ")).toBe("12.50");
    expect(codeOf(() => parseSignedMoney("1.234"))).toBe("INVALID_AMOUNT");
    expect(codeOf(() => parseSignedMoney("abc"))).toBe("INVALID_AMOUNT");
  });
});
