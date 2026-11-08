import { describe, expect, it } from "vitest";

import {
  assertValidConstraints,
  assertValidGroupDefinition,
  assertValidSelection,
  effectiveConstraints,
  validateSelection,
  type AttachmentOverrides,
  type GroupRule,
  type SelectionGroup,
} from "./modifier-selection";

const NO_OVERRIDES: AttachmentOverrides = {
  requiredOverride: null,
  minimumOverride: null,
  maximumOverride: null,
};

const group = (
  id: string,
  rule: GroupRule,
  overrides: AttachmentOverrides = NO_OVERRIDES,
  options: { active?: boolean; modifiers?: { id: string; active?: boolean }[] } = {},
): SelectionGroup => ({
  modifierGroupId: id,
  name: id,
  active: options.active ?? true,
  constraints: effectiveConstraints(rule, overrides),
  modifiers: (options.modifiers ?? [{ id: "a" }, { id: "b" }, { id: "c" }]).map((entry) => ({
    modifierId: entry.id,
    name: entry.id,
    active: entry.active ?? true,
  })),
});

const pick = (groupId: string, ...ids: string[]) =>
  ids.map((modifierId) => ({ modifierGroupId: groupId, modifierId }));

const REQUIRED_SINGLE: GroupRule = {
  selectionType: "REQUIRED_SINGLE",
  minimumSelections: 1,
  maximumSelections: 1,
};
const OPTIONAL_SINGLE: GroupRule = {
  selectionType: "OPTIONAL_SINGLE",
  minimumSelections: 0,
  maximumSelections: 1,
};
const REQUIRED_MULTIPLE: GroupRule = {
  selectionType: "REQUIRED_MULTIPLE",
  minimumSelections: 2,
  maximumSelections: 3,
};
const OPTIONAL_MULTIPLE: GroupRule = {
  selectionType: "OPTIONAL_MULTIPLE",
  minimumSelections: 0,
  maximumSelections: 2,
};

const codes = (groups: SelectionGroup[], selections: ReturnType<typeof pick>) =>
  validateSelection(groups, selections).map((violation) => violation.code);

describe("modifier selection", () => {
  it("required single: exactly one", () => {
    const groups = [group("temp", REQUIRED_SINGLE)];

    expect(codes(groups, [])).toEqual(["BELOW_MINIMUM"]);
    expect(codes(groups, pick("temp", "a"))).toEqual([]);
    expect(codes(groups, pick("temp", "a", "b"))).toEqual(["ABOVE_MAXIMUM"]);
  });

  it("optional single: zero or one", () => {
    const groups = [group("cheese", OPTIONAL_SINGLE)];

    expect(codes(groups, [])).toEqual([]);
    expect(codes(groups, pick("cheese", "a"))).toEqual([]);
    expect(codes(groups, pick("cheese", "a", "b"))).toEqual(["ABOVE_MAXIMUM"]);
  });

  it("required multiple: minimum and maximum enforced", () => {
    const groups = [group("sides", REQUIRED_MULTIPLE)];

    expect(codes(groups, pick("sides", "a"))).toEqual(["BELOW_MINIMUM"]);
    expect(codes(groups, pick("sides", "a", "b"))).toEqual([]);
    expect(codes(groups, pick("sides", "a", "b", "c"))).toEqual([]);
  });

  it("optional multiple: maximum enforced", () => {
    const groups = [group("addons", OPTIONAL_MULTIPLE)];

    expect(codes(groups, pick("addons", "a", "b"))).toEqual([]);
    expect(codes(groups, pick("addons", "a", "b", "c"))).toEqual(["ABOVE_MAXIMUM"]);
  });

  it("allows any number when an optional multiple group has no maximum", () => {
    const groups = [
      group("addons", {
        selectionType: "OPTIONAL_MULTIPLE",
        minimumSelections: 0,
        maximumSelections: null,
      }),
    ];

    expect(codes(groups, pick("addons", "a", "b", "c"))).toEqual([]);
  });

  it("rejects an inactive modifier", () => {
    const groups = [
      group("addons", OPTIONAL_MULTIPLE, NO_OVERRIDES, {
        modifiers: [{ id: "a" }, { id: "b", active: false }],
      }),
    ];

    expect(codes(groups, pick("addons", "b"))).toEqual(["MODIFIER_INACTIVE"]);
  });

  it("rejects a modifier or group that isn't attached", () => {
    const groups = [group("addons", OPTIONAL_MULTIPLE)];

    expect(codes(groups, pick("addons", "zzz"))).toEqual(["MODIFIER_NOT_IN_GROUP"]);
    expect(codes(groups, pick("other", "a"))).toEqual(["GROUP_NOT_ATTACHED"]);
  });

  it("does not require an inactive group, and refuses selections from it", () => {
    const groups = [group("temp", REQUIRED_SINGLE, NO_OVERRIDES, { active: false })];

    expect(codes(groups, [])).toEqual([]);
    expect(codes(groups, pick("temp", "a"))).toEqual(["GROUP_INACTIVE"]);
  });

  it("rejects choosing the same modifier twice", () => {
    const groups = [group("addons", OPTIONAL_MULTIPLE)];

    expect(codes(groups, pick("addons", "a", "a"))).toEqual(["DUPLICATE_SELECTION"]);
  });

  it("counts each group separately", () => {
    const groups = [group("temp", REQUIRED_SINGLE), group("addons", OPTIONAL_MULTIPLE)];

    expect(codes(groups, [...pick("temp", "a"), ...pick("addons", "b", "c")])).toEqual([]);
    expect(codes(groups, pick("addons", "b"))).toEqual(["BELOW_MINIMUM"]);
  });

  it("throws the first violation from assertValidSelection", () => {
    expect(() => assertValidSelection([group("temp", REQUIRED_SINGLE)], [])).toThrow(
      /Choose at least 1/,
    );
    expect(() => assertValidSelection([group("temp", REQUIRED_SINGLE)], pick("temp", "a"))).not.toThrow();
  });
});

describe("item overrides", () => {
  it("makes an optional group required, and a required group optional", () => {
    expect(
      effectiveConstraints(OPTIONAL_SINGLE, { ...NO_OVERRIDES, requiredOverride: true }),
    ).toEqual({ minimum: 1, maximum: 1 });
    expect(
      effectiveConstraints(REQUIRED_SINGLE, { ...NO_OVERRIDES, requiredOverride: false }),
    ).toEqual({ minimum: 0, maximum: 1 });
  });

  it("lets explicit minimum and maximum overrides win", () => {
    expect(
      effectiveConstraints(OPTIONAL_MULTIPLE, {
        requiredOverride: true,
        minimumOverride: 2,
        maximumOverride: 4,
      }),
    ).toEqual({ minimum: 2, maximum: 4 });
  });

  it("applies the override when validating a selection", () => {
    const groups = [
      group("addons", OPTIONAL_MULTIPLE, { ...NO_OVERRIDES, maximumOverride: 1 }),
    ];

    expect(codes(groups, pick("addons", "a", "b"))).toEqual(["ABOVE_MAXIMUM"]);
  });

  it("never lets a single-choice group exceed one", () => {
    expect(effectiveConstraints(REQUIRED_SINGLE, NO_OVERRIDES).maximum).toBe(1);
    expect(() =>
      assertValidConstraints(REQUIRED_SINGLE, { ...NO_OVERRIDES, maximumOverride: 3 }),
    ).toThrow(/single-choice/);
  });

  it("rejects a maximum below the minimum", () => {
    expect(() =>
      assertValidConstraints(OPTIONAL_MULTIPLE, { ...NO_OVERRIDES, minimumOverride: 3 }),
    ).toThrow(/below the minimum/);
  });
});

describe("group definitions", () => {
  it("accepts the four valid shapes", () => {
    for (const rule of [REQUIRED_SINGLE, OPTIONAL_SINGLE, REQUIRED_MULTIPLE, OPTIONAL_MULTIPLE]) {
      expect(() => assertValidGroupDefinition(rule)).not.toThrow();
    }
  });

  it("rejects negative minimums and a maximum below the minimum", () => {
    expect(() =>
      assertValidGroupDefinition({ ...OPTIONAL_MULTIPLE, minimumSelections: -1 }),
    ).toThrow(/negative/);
    expect(() =>
      assertValidGroupDefinition({ ...REQUIRED_MULTIPLE, maximumSelections: 1 }),
    ).toThrow(/below the minimum/);
  });

  it("rejects counts that don't fit the selection type", () => {
    expect(() =>
      assertValidGroupDefinition({ ...REQUIRED_SINGLE, maximumSelections: 2 }),
    ).toThrow(/fit/);
    expect(() =>
      assertValidGroupDefinition({ ...OPTIONAL_SINGLE, minimumSelections: 1 }),
    ).toThrow(/fit/);
  });
});
