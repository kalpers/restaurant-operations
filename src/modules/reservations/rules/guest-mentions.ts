// Phase 33 (policy 3): how a guest's name, email or phone is recognized in free text, such as
// the manager log and pre-shift notes. Pure functions: what they find is only a suggestion,
// and a person confirms each mention before anything is redacted (policy 2).

/** A guest's identifiers, read from the profile, merged profiles and visits before an erase. */
export type GuestIdentifiers = {
  names: readonly (string | null | undefined)[];
  emails: readonly (string | null | undefined)[];
  phones: readonly (string | null | undefined)[];
};

export type MentionTerms = {
  /** Whole names and name parts of 4 or more letters, lower-cased, longest first. */
  names: string[];
  /** Full emails, lower-cased. */
  emails: string[];
  /** The last 7 digits of each phone number. */
  phoneTails: string[];
};

/** Names that are placeholders, not a guest's name. */
const IGNORED_NAMES = new Set(["erased guest", "guest", "walk-in", "walk in"]);

/** A name part needs this many letters to be searched on its own. */
export const MIN_NAME_PART_LETTERS = 4;

/** The number of trailing phone digits compared. */
export const PHONE_TAIL_DIGITS = 7;

const clean = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/** The search terms for a guest's identifiers, without duplicates. */
export function mentionTerms(identifiers: GuestIdentifiers): MentionTerms {
  const names = new Set<string>();

  for (const raw of identifiers.names) {
    const name = raw ? clean(raw) : "";

    if (name.length < 2 || IGNORED_NAMES.has(name)) {
      continue;
    }

    names.add(name);

    for (const part of name.split(/[\s.,'’()-]+/u)) {
      if ([...part].filter((character) => /\p{L}/u.test(character)).length >= MIN_NAME_PART_LETTERS) {
        names.add(part);
      }
    }
  }

  const emails = new Set<string>();

  for (const raw of identifiers.emails) {
    const email = raw ? clean(raw) : "";

    if (email.includes("@")) {
      emails.add(email);
    }
  }

  const phoneTails = new Set<string>();

  for (const raw of identifiers.phones) {
    const digits = (raw ?? "").replace(/\D/g, "");

    if (digits.length >= PHONE_TAIL_DIGITS) {
      phoneTails.add(digits.slice(-PHONE_TAIL_DIGITS));
    }
  }

  return {
    names: [...names].sort((a, b) => b.length - a.length || a.localeCompare(b)),
    emails: [...emails].sort(),
    phoneTails: [...phoneTails].sort(),
  };
}

export function hasTerms(terms: MentionTerms): boolean {
  return terms.names.length + terms.emails.length + terms.phoneTails.length > 0;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A whole-word, case-insensitive pattern: no letter or digit directly before or after. */
function wholeWord(term: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term).replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu");
}

/** Runs of digits that may be written with spaces, dashes, dots, brackets or a plus sign. */
const PHONE_RUN = /\+?\(?\d[\d\s().-]*\d/g;

export type MentionMatch = { index: number; length: number };

/** The first mention of the guest in a text, or null. */
export function findMention(text: string, terms: MentionTerms): MentionMatch | null {
  const matches: MentionMatch[] = [];

  for (const term of [...terms.names, ...terms.emails]) {
    const found = wholeWord(term).exec(text);

    if (found) {
      matches.push({ index: found.index, length: found[0].length });
    }
  }

  if (terms.phoneTails.length > 0) {
    for (const run of text.matchAll(PHONE_RUN)) {
      const digits = run[0].replace(/\D/g, "");

      // A phone number is 7 to 15 digits; its last 7 must be the guest's. A 7-digit run in
      // the middle of a longer number (an invoice, a card) doesn't count.
      if (digits.length >= PHONE_TAIL_DIGITS && digits.length <= 15 && terms.phoneTails.includes(digits.slice(-PHONE_TAIL_DIGITS))) {
        matches.push({ index: run.index, length: run[0].length });
      }
    }
  }

  if (matches.length === 0) {
    return null;
  }

  return matches.sort((a, b) => a.index - b.index)[0]!;
}

/** A short piece of the text around a mention, for the person deciding. */
export function excerptAround(text: string, match: MentionMatch, context = 60): string {
  const start = Math.max(0, match.index - context);
  const end = Math.min(text.length, match.index + match.length + context);

  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

/** Phase 34 (policy 12): what a redacted mention becomes. */
export const REDACTION_MARK = "[redacted]";

/** Every mention of the guest in a text, overlapping ones merged, in order. */
export function findAllMentions(text: string, terms: MentionTerms): MentionMatch[] {
  const ranges: MentionMatch[] = [];

  for (const term of [...terms.names, ...terms.emails]) {
    const pattern = new RegExp(wholeWord(term).source, "giu");

    for (const found of text.matchAll(pattern)) {
      ranges.push({ index: found.index, length: found[0].length });
    }
  }

  if (terms.phoneTails.length > 0) {
    for (const run of text.matchAll(PHONE_RUN)) {
      const digits = run[0].replace(/\D/g, "");

      if (digits.length >= PHONE_TAIL_DIGITS && digits.length <= 15 && terms.phoneTails.includes(digits.slice(-PHONE_TAIL_DIGITS))) {
        ranges.push({ index: run.index, length: run[0].length });
      }
    }
  }

  ranges.sort((a, b) => a.index - b.index || b.length - a.length);

  const merged: MentionMatch[] = [];

  for (const range of ranges) {
    const last = merged.at(-1);

    if (last && range.index <= last.index + last.length) {
      last.length = Math.max(last.length, range.index + range.length - last.index);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

/**
 * Phase 34 (policy 12): the text with each mention replaced by "[redacted]" and everything else
 * kept, so an instruction such as "No onion" survives. Unchanged when nothing matches.
 */
export function redactMentions(text: string, terms: MentionTerms): string {
  let result = "";
  let position = 0;

  for (const match of findAllMentions(text, terms)) {
    result += text.slice(position, match.index) + REDACTION_MARK;
    position = match.index + match.length;
  }

  return position === 0 ? text : result + text.slice(position);
}
