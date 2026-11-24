import { describe, expect, it } from "vitest";

import { AppError } from "@/shared/errors/app-error";

import {
  assertInvoiceTransition,
  assertTotalsMatch,
  chargeLineAmount,
  formatInvoiceNumber,
  itemLineAmount,
  lineVariance,
  supplierDocumentNumber,
} from "./invoice-rules";

const codeOf = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return (error as AppError).code;
  }

  return undefined;
};

const tolerance = { percent: "2.00", amount: "0.5000" };
const facts = (overrides: Partial<Parameters<typeof lineVariance>[0]> = {}) => ({
  receivedQuantity: "10.0000",
  invoicedQuantity: "10.0000",
  receiptUnitCost: "300.0000",
  orderedUnitPrice: "300.0000",
  invoicedUnitPrice: "300.0000",
  amount: "3000.00",
  ...overrides,
});

describe("supplier invoice rules (Phase 36 policy 8)", () => {
  it("prices item lines to the cent and stores credits negative", () => {
    expect(itemLineAmount("3.0000", "12.3456")).toBe("37.04");
    expect(chargeLineAmount("FREIGHT", "25")).toBe("25.00");
    expect(chargeLineAmount("CREDIT", "10.50")).toBe("-10.50");
    expect(codeOf(() => chargeLineAmount("TAX", "-1"))).toBe("INVOICE_AMOUNT_INVALID");
  });

  it("checks the lines against the stated total", () => {
    expect(codeOf(() => assertTotalsMatch(["3000.00", "25.00", "-10.00"], "3015.00"))).toBeUndefined();
    expect(codeOf(() => assertTotalsMatch(["3000.00"], "3000.01"))).toBe("INVOICE_TOTAL_MISMATCH");
  });

  it("finds no variance on a matching line", () => {
    expect(lineVariance(facts(), tolerance)).toEqual({
      quantityVariance: "0.0000",
      priceVariance: "0.0000",
      amountVariance: "0.00",
      pricePercent: "0.00",
      priceWithinTolerance: true,
      quantityMatches: true,
      withinTolerance: true,
    });
  });

  it("uses the larger of the percent and the amount", () => {
    // 2% of 300.00 is 6.00 per case.
    expect(lineVariance(facts({ invoicedUnitPrice: "306.0000", amount: "3060.00" }), tolerance).priceWithinTolerance).toBe(true);
    expect(lineVariance(facts({ invoicedUnitPrice: "306.0100", amount: "3060.10" }), tolerance).priceWithinTolerance).toBe(false);
    // On a 10.00 item, 2% is 0.20, so the 0.50 amount applies.
    const cheap = facts({ receiptUnitCost: "10.0000", invoicedUnitPrice: "10.5000", amount: "105.00" });

    expect(lineVariance(cheap, tolerance)).toMatchObject({ priceWithinTolerance: true, pricePercent: "5.00", amountVariance: "5.00" });
    expect(lineVariance({ ...cheap, invoicedUnitPrice: "9.4000", amount: "94.00" }, tolerance).priceWithinTolerance).toBe(false);
  });

  it("allows no quantity variance", () => {
    expect(lineVariance(facts({ invoicedQuantity: "11.0000", amount: "3300.00" }), tolerance)).toMatchObject({
      quantityVariance: "1.0000",
      quantityMatches: false,
      withinTolerance: false,
    });
  });

  it("has no percent on a free receipt", () => {
    expect(lineVariance(facts({ receiptUnitCost: "0.0000", invoicedUnitPrice: "0.0000", amount: "0.00" }), tolerance).pricePercent).toBeNull();
  });

  it("moves draft and disputed invoices on, and voids approved ones", () => {
    expect(codeOf(() => assertInvoiceTransition("DRAFT", "APPROVED"))).toBeUndefined();
    expect(codeOf(() => assertInvoiceTransition("DISPUTED", "APPROVED"))).toBeUndefined();
    expect(codeOf(() => assertInvoiceTransition("APPROVED", "VOIDED"))).toBeUndefined();
    expect(codeOf(() => assertInvoiceTransition("APPROVED", "DISPUTED"))).toBe("INVOICE_STATUS_INVALID");
    expect(codeOf(() => assertInvoiceTransition("VOIDED", "APPROVED"))).toBe("INVOICE_STATUS_INVALID");
  });

  it("takes the supplier's number as printed, long digit runs included", () => {
    expect(supplierDocumentNumber(" 4411-2023/07 ")).toBe("4411-2023/07");
    expect(supplierDocumentNumber("1234567890123456")).toBe("1234567890123456");
    expect(codeOf(() => supplierDocumentNumber("A 1"))).toBe("INVOICE_NUMBER_INVALID");
    expect(formatInvoiceNumber(42)).toBe("INV-000042");
  });
});
