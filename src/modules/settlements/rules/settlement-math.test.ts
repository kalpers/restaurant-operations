import { describe, expect, it } from "vitest";

import { AppError } from "@/shared/errors/app-error";

import {
  assertCanComplete,
  assertSettlementOpen,
  looksLikeCardNumber,
  parseMoney,
  planTender,
  previewChange,
  reconcile,
  type TenderFacts,
} from "./settlement-math";

const recorded = (amount: string, tipAmount = "0.00", changeAmount = "0.00"): TenderFacts => ({
  status: "RECORDED",
  amount,
  tipAmount,
  changeAmount,
});

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return error instanceof AppError ? error.code : "NOT_APP_ERROR";
  }

  return undefined;
}

describe("exact settlement math", () => {
  it("settles a single exact tender", () => {
    expect(reconcile("42.50", [recorded("42.50")])).toEqual({
      tenderedAmount: "42.50",
      tipAmount: "0.00",
      changeDue: "0.00",
      remainingAmount: "0.00",
    });
  });

  it("sums several tenders exactly, $75 = $25 cash + $50 card", () => {
    const result = reconcile("75.00", [recorded("25.00", "2.00", "3.00"), recorded("50.00", "8.00")]);

    expect(result).toEqual({ tenderedAmount: "75.00", tipAmount: "10.00", changeDue: "3.00", remainingAmount: "0.00" });
  });

  it("reports what remains", () => {
    expect(reconcile("30.00", [recorded("12.34")]).remainingAmount).toBe("17.66");
  });

  it("has no floating-point drift (0.1 + 0.2 is exactly 0.30)", () => {
    expect(reconcile("0.30", [recorded("0.10"), recorded("0.20")]).remainingAmount).toBe("0.00");
    expect(reconcile("100.00", Array.from({ length: 10 }, () => recorded("10.00"))).remainingAmount).toBe("0.00");
  });

  it("ignores VOIDED and FAILED tenders", () => {
    const result = reconcile("20.00", [
      { ...recorded("20.00"), status: "VOIDED" },
      { ...recorded("20.00"), status: "FAILED" },
      recorded("5.00"),
    ]);

    expect(result.tenderedAmount).toBe("5.00");
    expect(result.remainingAmount).toBe("15.00");
  });

  it("allows a zero-amount order to complete with no tender", () => {
    expect(assertCanComplete("0.00", [], 0).remainingAmount).toBe("0.00");
  });

  it("settles a discounted amount (the snapshot), not the pre-discount price", () => {
    expect(() => assertCanComplete("13.50", [recorded("13.50")], 0)).not.toThrow();
    expect(codeOf(() => assertCanComplete("13.50", [recorded("15.00")], 0))).toBe("OVER_SETTLED");
  });
});

describe("cash tenders", () => {
  const cash = (amount: string, receivedAmount: string, tipAmount?: string) =>
    planTender({ tenderType: "CASH", outcome: "RECORDED", amount, receivedAmount, tipAmount }, "18.50");

  it("records exact cash with no change", () => {
    expect(cash("18.50", "18.50")).toMatchObject({ amount: "18.50", receivedAmount: "18.50", changeAmount: "0.00" });
  });

  it("returns overpayment as change, not tender value", () => {
    expect(cash("18.50", "20.00")).toMatchObject({ amount: "18.50", changeAmount: "1.50" });
  });

  it("takes change after the tip: 18.50 + 1.00 tip from 20.00 is 0.50 change", () => {
    expect(cash("18.50", "20.00", "1.00")).toMatchObject({ tipAmount: "1.00", changeAmount: "0.50" });
  });

  it("refuses cash that doesn't cover amount and tip", () => {
    expect(codeOf(() => cash("18.50", "18.00"))).toBe("INSUFFICIENT_CASH");
    expect(codeOf(() => cash("18.50", "19.00", "1.00"))).toBe("INSUFFICIENT_CASH");
  });

  it("refuses negative amounts and fractions of a cent", () => {
    expect(codeOf(() => cash("-1.00", "20.00"))).toBe("INVALID_AMOUNT");
    expect(codeOf(() => cash("1.005", "20.00"))).toBe("INVALID_AMOUNT");
    expect(codeOf(() => cash("0.00", "20.00"))).toBe("INVALID_AMOUNT");
    expect(codeOf(() => cash("1.00", "20.00", "-1"))).toBe("INVALID_AMOUNT");
  });

  it("needs the cash received", () => {
    expect(codeOf(() => planTender({ tenderType: "CASH", outcome: "RECORDED", amount: "1.00" }, "5.00"))).toBe(
      "RECEIVED_REQUIRED",
    );
  });

  it("never applies more than remains", () => {
    expect(codeOf(() => cash("20.00", "20.00"))).toBe("AMOUNT_EXCEEDS_REMAINING");
  });

  it("previews change for the UI and gives null when short", () => {
    expect(previewChange("18.50", "1.00", "20.00")).toBe("0.50");
    expect(previewChange("18.50", "0", "10.00")).toBeNull();
    expect(previewChange("x", "0", "10.00")).toBeNull();
  });
});

describe("external card and other tenders", () => {
  it("records an approved external card with a separate tip", () => {
    expect(
      planTender({ tenderType: "EXTERNAL_CARD", outcome: "RECORDED", amount: "50.00", tipAmount: "9.00" }, "50.00"),
    ).toEqual({ status: "RECORDED", amount: "50.00", tipAmount: "9.00", receivedAmount: null, changeAmount: "0.00" });
  });

  it("refuses an over-applied non-cash tender", () => {
    expect(
      codeOf(() => planTender({ tenderType: "EXTERNAL_CARD", outcome: "RECORDED", amount: "50.01" }, "50.00")),
    ).toBe("AMOUNT_EXCEEDS_REMAINING");
  });

  it("records a reported failure that contributes nothing", () => {
    const failed = planTender(
      { tenderType: "EXTERNAL_CARD", outcome: "FAILED", amount: "80.00", failureReason: "Declined at terminal" },
      "50.00",
    );

    expect(failed.status).toBe("FAILED");
    expect(reconcile("50.00", [{ ...failed, status: "FAILED" }]).remainingAmount).toBe("50.00");
  });

  it("needs a failure reason, and only cards can fail", () => {
    expect(codeOf(() => planTender({ tenderType: "EXTERNAL_CARD", outcome: "FAILED", amount: "5.00" }, "5.00"))).toBe(
      "FAILURE_REASON_REQUIRED",
    );
    expect(
      codeOf(() =>
        planTender({ tenderType: "GIFT_CARD", outcome: "FAILED", amount: "5.00", failureReason: "no" }, "5.00"),
      ),
    ).toBe("FAILURE_NOT_ALLOWED");
  });

  it("allows tips only on cash and external card", () => {
    for (const tenderType of ["GIFT_CARD", "HOUSE_ACCOUNT", "OTHER"] as const) {
      expect(
        codeOf(() =>
          planTender({ tenderType, outcome: "RECORDED", amount: "5.00", tipAmount: "1.00", otherDescription: "x" }, "5.00"),
        ),
      ).toBe("TIP_NOT_ALLOWED");
    }
  });

  it("needs a description for OTHER", () => {
    expect(codeOf(() => planTender({ tenderType: "OTHER", outcome: "RECORDED", amount: "5.00" }, "5.00"))).toBe(
      "DESCRIPTION_REQUIRED",
    );
    expect(
      planTender({ tenderType: "OTHER", outcome: "RECORDED", amount: "5.00", otherDescription: "Voucher #12" }, "5.00")
        .status,
    ).toBe("RECORDED");
  });

  it("refuses anything that looks like a card number in any text field", () => {
    expect(
      codeOf(() =>
        planTender(
          { tenderType: "EXTERNAL_CARD", outcome: "RECORDED", amount: "5.00", textFields: ["4111 1111 1111 1111"] },
          "5.00",
        ),
      ),
    ).toBe("CARD_DATA_REFUSED");
    expect(looksLikeCardNumber("4111-1111-1111-1111")).toBe(true);
    expect(looksLikeCardNumber("AUTH 123456")).toBe(false);
    expect(looksLikeCardNumber(null)).toBe(false);
  });

  it("refuses cash received on a non-cash tender", () => {
    expect(
      codeOf(() =>
        planTender({ tenderType: "GIFT_CARD", outcome: "RECORDED", amount: "5.00", receivedAmount: "5.00" }, "5.00"),
      ),
    ).toBe("RECEIVED_NOT_ALLOWED");
  });
});

describe("reconciliation and lifecycle", () => {
  it("refuses completion while anything remains", () => {
    expect(codeOf(() => assertCanComplete("20.00", [recorded("19.99")], 0))).toBe("SETTLEMENT_NOT_BALANCED");
  });

  it("completes mixed cash and card exactly", () => {
    expect(assertCanComplete("75.00", [recorded("25.00", "0.00", "5.00"), recorded("50.00")], 0).remainingAmount).toBe(
      "0.00",
    );
  });

  it("drops a voided tender from the sum", () => {
    expect(
      codeOf(() => assertCanComplete("20.00", [{ ...recorded("20.00"), status: "VOIDED" }], 0)),
    ).toBe("SETTLEMENT_NOT_BALANCED");
  });

  it("refuses completion while draft items remain", () => {
    expect(codeOf(() => assertCanComplete("0.00", [], 1))).toBe("DRAFT_ITEMS_PRESENT");
  });

  it("accepts tenders only while OPEN; COMPLETED and CANCELLED are terminal", () => {
    expect(() => assertSettlementOpen("OPEN")).not.toThrow();
    expect(codeOf(() => assertSettlementOpen("COMPLETED"))).toBe("SETTLEMENT_NOT_OPEN");
    expect(codeOf(() => assertSettlementOpen("CANCELLED"))).toBe("SETTLEMENT_NOT_OPEN");
  });

  it("normalizes money to cents", () => {
    expect(parseMoney("5", "amount")).toBe("5.00");
    expect(parseMoney("5.5", "amount")).toBe("5.50");
    expect(parseMoney("5.500", "amount")).toBe("5.50");
    expect(codeOf(() => parseMoney("abc", "amount"))).toBe("INVALID_AMOUNT");
  });
});
