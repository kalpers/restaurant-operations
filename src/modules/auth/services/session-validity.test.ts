import { describe, expect, it } from "vitest";

import {
  generateTemporaryPassword,
  MINIMUM_PASSWORD_LENGTH,
  TEMPORARY_PASSWORD_ALPHABET,
  TEMPORARY_PASSWORD_LENGTH,
} from "../password";
import { isSessionCurrent } from "./session-validity";

describe("session check after a password change", () => {
  const changedAt = new Date("2026-11-10T12:00:00.000Z");

  it("rejects a session signed in before the change", () => {
    expect(isSessionCurrent(changedAt.getTime() - 1, changedAt)).toBe(false);
  });

  it("accepts a session signed in at the change instant (the changer's fresh session)", () => {
    expect(isSessionCurrent(changedAt.getTime(), changedAt)).toBe(true);
  });

  it("accepts a session signed in after the change", () => {
    expect(isSessionCurrent(changedAt.getTime() + 1, changedAt)).toBe(true);
  });

  it("keeps a pre-Phase 16 token with no authTime valid until a change", () => {
    expect(isSessionCurrent(undefined, null)).toBe(true);
    expect(isSessionCurrent(undefined, changedAt)).toBe(false);
  });

  it("accepts any session when the password was never changed", () => {
    expect(isSessionCurrent(0, null)).toBe(true);
  });
});

describe("temporary password generator", () => {
  it("makes 16 characters from the URL-safe alphabet, meeting the minimum length", () => {
    expect(TEMPORARY_PASSWORD_ALPHABET).toHaveLength(64);
    expect(new Set(TEMPORARY_PASSWORD_ALPHABET).size).toBe(64);
    expect(TEMPORARY_PASSWORD_LENGTH).toBeGreaterThanOrEqual(MINIMUM_PASSWORD_LENGTH);

    for (let draw = 0; draw < 200; draw += 1) {
      const password = generateTemporaryPassword();

      expect(password).toHaveLength(16);
      expect(password).toMatch(/^[A-Za-z0-9_-]{16}$/);
    }
  });

  it("does not repeat across many draws and uses the whole alphabet", () => {
    const draws = Array.from({ length: 5000 }, () => generateTemporaryPassword());
    const characters = new Set(draws.join(""));

    expect(new Set(draws).size).toBe(draws.length);
    expect(characters.size).toBe(64);
  });
});
