import { describe, expect, it } from "vitest";

import { checkSupplierCode } from "./gift-card-code";
import { formatStockBatchNumber, MAX_STOCK_BATCH, parseStockList } from "./gift-card-stock";

const KEY = "k".repeat(32);

// Phase 34 (policies 7–8): reading a batch of supplier cards.

describe("parsing a stock list", () => {
  it("reads bare codes and serial,code lines, skipping a header and blank lines", () => {
    const result = parseStockList(["serial,code", "SN-001,ABCD-EFGH-1234", "", "  WXYZ5678QRST  ", '"SN-003";"MNOP 9876 KLMN"'], KEY);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.cards.map((card) => [card.line, card.serial, card.lastFour])).toEqual([
      [2, "SN-001", "1234"],
      [4, null, "QRST"],
      [5, "SN-003", "KLMN"],
    ]);
    expect(result.cards[0]!.codeHash).toBe((checkSupplierCode("ABCDEFGH1234", KEY) as { codeHash: string }).codeHash);
  });

  it("reports every problem by line number and never the code", () => {
    const result = parseStockList(["ABCDEFGH1234", "abcd-efgh-1234", "SHORT", "4111111111111111", "a,b,c", `${"9".repeat(13)},ZZZZ9999YYYY`], KEY);

    expect(result).toEqual({
      ok: false,
      reason: "LINES",
      problems: [
        { line: 2, problem: "DUPLICATE_IN_BATCH" },
        { line: 3, problem: "INVALID_CODE" },
        { line: 4, problem: "LOOKS_LIKE_CARD_NUMBER" },
        { line: 5, problem: "TOO_MANY_FIELDS" },
        { line: 6, problem: "INVALID_SERIAL" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("ABCDEFGH");
  });

  it("refuses an empty list and more than the limit", () => {
    expect(parseStockList(["", "  "], KEY)).toEqual({ ok: false, reason: "EMPTY" });

    const many = Array.from({ length: MAX_STOCK_BATCH + 1 }, (_, index) => `CODE${String(index).padStart(6, "0")}AB`);

    expect(parseStockList(many, KEY)).toEqual({ ok: false, reason: "TOO_MANY" });
  });

  it("numbers batches as GCB-000012", () => {
    expect(formatStockBatchNumber(12)).toBe("GCB-000012");
  });
});
