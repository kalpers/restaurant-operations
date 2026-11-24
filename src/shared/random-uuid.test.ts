import { afterEach, describe, expect, it, vi } from "vitest";

import { randomUuid } from "./random-uuid";

afterEach(() => vi.unstubAllGlobals());

describe("randomUuid", () => {
  it("makes distinct version 4 UUIDs without crypto.randomUUID", () => {
    const { crypto } = globalThis;
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });

    const ids = Array.from({ length: 100 }, randomUuid);

    expect(new Set(ids).size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});
