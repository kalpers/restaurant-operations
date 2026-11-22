import { or, sql, type SQL } from "drizzle-orm";

// Phase 34 (policies 11–14, amendment 7): what each domain needs to offer its free text to a
// guest erase without knowing how a guest is recognized. The erase workflow passes the words
// and digit runs to search for (a broad first pass), decides which candidates really mention
// the guest, and hands back a function that redacts a text word by word.

/** The broad first pass: any of the words (any case), or any digit run among a text's digits. */
export type FreeTextQuery = {
  words: readonly string[];
  digitRuns: readonly string[];
};

/** One row's text that may mention someone. `date` is a business or calendar date for display. */
export type FreeTextCandidate = {
  id: string;
  locationId: string | null;
  locationName: string | null;
  date: string | null;
  label: string;
  text: string;
};

/** Replaces the mentions in a text with "[redacted]"; returns the text unchanged when none. */
export type RedactText = (text: string) => string;

/** A LIKE pattern that finds `text` anywhere, with LIKE's own characters escaped. */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export function hasQuery(query: FreeTextQuery): boolean {
  return query.words.length + query.digitRuns.length > 0;
}

/** A condition true when any of the columns holds any word or digit run of the query. */
export function freeTextCondition(columns: readonly SQL[], query: FreeTextQuery): SQL {
  return or(
    ...query.words.flatMap((word) => columns.map((column) => sql`${column} ILIKE ${likeContains(word)}`)),
    ...query.digitRuns.flatMap((digits) =>
      columns.map((column) => sql`regexp_replace(coalesce(${column}, ''), '[^0-9]', '', 'g') LIKE ${likeContains(digits)}`),
    ),
  )!;
}

/** A row's columns joined for matching: the first non-empty ones, one per line. */
export function joinTexts(...texts: (string | null | undefined)[]): string {
  return texts.filter((text): text is string => Boolean(text && text.trim())).join("\n");
}
