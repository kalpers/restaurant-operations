import { describe, expect, it } from "vitest";

import { excerptAround, findMention, hasTerms, mentionTerms } from "./guest-mentions";

// Phase 33 (policy 3): recognizing a guest in free text.

const terms = mentionTerms({
  names: ["Maria Alvarez-Ruiz", "Erased guest", null],
  emails: ["Maria.A@Example.com"],
  phones: ["(555) 123-4567"],
});

describe("mention terms", () => {
  it("keeps the whole name, name parts of 4 or more letters, full emails and the last 7 phone digits", () => {
    expect(terms.names).toEqual(["maria alvarez-ruiz", "alvarez", "maria", "ruiz"]);
    expect(terms.emails).toEqual(["maria.a@example.com"]);
    expect(terms.phoneTails).toEqual(["1234567"]);
  });

  it("ignores placeholders, short parts and short phone numbers", () => {
    const few = mentionTerms({ names: ["Al Bo", "Walk-in"], emails: ["not-an-email"], phones: ["12345"] });

    expect(few.names).toEqual(["al bo"]);
    expect(few.emails).toEqual([]);
    expect(few.phoneTails).toEqual([]);
    expect(hasTerms(mentionTerms({ names: [], emails: [], phones: [] }))).toBe(false);
  });
});

describe("finding a mention", () => {
  it("matches names as whole words in any case", () => {
    expect(findMention("Mrs. ALVAREZ complained about the steak", terms)).not.toBeNull();
    expect(findMention("Mariachi band booked", terms)).toBeNull();
    expect(findMention("Alvarezes", terms)).toBeNull();
  });

  it("matches a full email", () => {
    expect(findMention("Wrote to maria.a@example.com about the booking", terms)).not.toBeNull();
  });

  it("matches the phone however it is written", () => {
    for (const text of ["call 555 123 4567", "called 555-123-4567 back", "ph (555)123.4567", "+1 555 1234567", "123-4567"]) {
      expect(findMention(text, terms), text).not.toBeNull();
    }
  });

  it("doesn't match 7 digits inside a longer number", () => {
    expect(findMention("invoice 99912345678881", terms)).toBeNull();
    expect(findMention("order 12345670", terms)).toBeNull();
  });

  it("returns the first mention, and an excerpt around it", () => {
    const text = `${"x".repeat(100)} Maria called ${"y".repeat(100)}`;
    const match = findMention(text, terms)!;

    expect(text.slice(match.index, match.index + match.length)).toBe("Maria");
    expect(excerptAround(text, match)).toMatch(/^….*Maria called.*…$/);
  });
});
