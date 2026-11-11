import { describe, expect, it } from "vitest";

import { splitTipPool, totalWeightedHours, type TipParticipant } from "./tip-split";

const H = 3600;

function participant(overrides: Partial<TipParticipant> & Pick<TipParticipant, "employeeId">): TipParticipant {
  return {
    employeeNumber: overrides.employeeId,
    positionId: "server",
    positionCode: "SERVER",
    workedSeconds: 6 * H,
    points: "10",
    ...overrides,
  };
}

const sum = (shares: string[]) => shares.reduce((total, share) => total + Math.round(Number(share) * 100), 0);

describe("splitTipPool", () => {
  it("splits by hours × points and adds up exactly", () => {
    const lines = splitTipPool("300.00", [
      participant({ employeeId: "a", workedSeconds: 6 * H, points: "10" }),
      participant({ employeeId: "b", workedSeconds: 6 * H, points: "10" }),
      participant({ employeeId: "c", workedSeconds: 6 * H, points: "5", positionCode: "BUSSER" }),
    ]);

    expect(lines.map((line) => line.share)).toEqual(["120.00", "120.00", "60.00"]);
    expect(lines.map((line) => line.weightedHours)).toEqual(["60.0000", "60.0000", "30.0000"]);
    expect(totalWeightedHours(lines)).toBe("150.0000");
  });

  it("gives leftover cents by largest remainder, then employee number", () => {
    const lines = splitTipPool("100.00", [
      participant({ employeeId: "x3", employeeNumber: "E3" }),
      participant({ employeeId: "x1", employeeNumber: "E1" }),
      participant({ employeeId: "x2", employeeNumber: "E2" }),
    ]);

    expect(lines.map((line) => [line.employeeNumber, line.share])).toEqual([
      ["E3", "33.33"],
      ["E1", "33.34"],
      ["E2", "33.33"],
    ]);
    expect(sum(lines.map((line) => line.share))).toBe(10000);
  });

  it("always sums exactly for awkward weights", () => {
    const lines = splitTipPool("487.13", [
      participant({ employeeId: "a", workedSeconds: 7 * H + 1234, points: "10" }),
      participant({ employeeId: "b", workedSeconds: 3 * H + 17, points: "7.5" }),
      participant({ employeeId: "c", workedSeconds: 5 * H + 999, points: "3.33" }),
      participant({ employeeId: "d", workedSeconds: 61, points: "1" }),
    ]);

    expect(sum(lines.map((line) => line.share))).toBe(48713);
  });

  it("keeps one employee's two positions as separate lines", () => {
    const lines = splitTipPool("90.00", [
      participant({ employeeId: "a", positionId: "server", positionCode: "SERVER", workedSeconds: 4 * H }),
      participant({ employeeId: "a", positionId: "bar", positionCode: "BARTENDER", workedSeconds: 2 * H }),
    ]);

    expect(lines.map((line) => [line.positionCode, line.share])).toEqual([
      ["SERVER", "60.00"],
      ["BARTENDER", "30.00"],
    ]);
  });

  it("handles a zero pool and nobody who worked", () => {
    expect(splitTipPool("0.00", [participant({ employeeId: "a" })]).map((line) => line.share)).toEqual(["0.00"]);
    expect(splitTipPool("50.00", [participant({ employeeId: "a", workedSeconds: 0 })])).toEqual([]);
    expect(splitTipPool("50.00", [])).toEqual([]);
  });
});
