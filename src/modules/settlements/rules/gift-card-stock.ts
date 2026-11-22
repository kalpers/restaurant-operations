import { checkSupplierCode } from "./gift-card-code";
import { looksLikeCardNumber } from "./settlement-math";

// Phase 34 (policies 7–8): reading a batch of supplier cards from what a manager pasted, or a
// CSV file the browser read: one card per line, `code` or `serial,code`. Pure. Every problem
// is reported by line number only, never with the code itself.

export const MAX_STOCK_BATCH = 1000;
export const MAX_SERIAL_LENGTH = 40;

export type StockLine = { line: number; serial: string | null; codeHash: string; lastFour: string };

export type StockLineProblem =
  | "INVALID_CODE"
  | "LOOKS_LIKE_CARD_NUMBER"
  | "DUPLICATE_IN_BATCH"
  | "INVALID_SERIAL"
  | "TOO_MANY_FIELDS";

export type StockListResult =
  | { ok: true; cards: StockLine[] }
  | { ok: false; reason: "EMPTY" | "TOO_MANY" }
  | { ok: false; reason: "LINES"; problems: { line: number; problem: StockLineProblem }[] };

/** A header row of a CSV file, which is skipped. */
const HEADER = /^\s*(?:"?(?:serial|printed serial)"?\s*[,;\t]\s*)?"?(?:code|card code)"?\s*$/i;

const unquote = (value: string) => value.trim().replace(/^"(.*)"$/, "$1").trim();

/** Reads the lines into cards, or every problem with its line number (1-based). */
export function parseStockList(lines: readonly string[]): StockListResult {
  const cards: StockLine[] = [];
  const problems: { line: number; problem: StockLineProblem }[] = [];
  const seen = new Map<string, number>();

  lines.forEach((raw, index) => {
    const line = index + 1;

    if (raw.trim() === "" || (index === 0 && HEADER.test(raw))) {
      return;
    }

    const fields = raw.split(/[,;\t]/).map(unquote);

    if (fields.length > 2) {
      problems.push({ line, problem: "TOO_MANY_FIELDS" });

      return;
    }

    const [first, second] = fields;
    const code = fields.length === 2 ? second! : first!;
    const serial = fields.length === 2 && first ? first : null;

    if (serial !== null && (serial.length > MAX_SERIAL_LENGTH || looksLikeCardNumber(serial))) {
      problems.push({ line, problem: "INVALID_SERIAL" });

      return;
    }

    const checked = checkSupplierCode(code);

    if (!checked.ok) {
      problems.push({ line, problem: checked.reason === "LOOKS_LIKE_CARD_NUMBER" ? "LOOKS_LIKE_CARD_NUMBER" : "INVALID_CODE" });

      return;
    }

    if (seen.has(checked.codeHash)) {
      problems.push({ line, problem: "DUPLICATE_IN_BATCH" });

      return;
    }

    seen.set(checked.codeHash, line);
    cards.push({ line, serial, codeHash: checked.codeHash, lastFour: checked.lastFour });
  });

  if (problems.length > 0) {
    return { ok: false, reason: "LINES", problems };
  }

  if (cards.length === 0) {
    return { ok: false, reason: "EMPTY" };
  }

  if (cards.length > MAX_STOCK_BATCH) {
    return { ok: false, reason: "TOO_MANY" };
  }

  return { ok: true, cards };
}

/** The non-secret batch number: `GCB-000012`. */
export function formatStockBatchNumber(batchNumber: number): string {
  return `GCB-${String(batchNumber).padStart(6, "0")}`;
}
