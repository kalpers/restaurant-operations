import { BusinessRuleError } from "@/shared/errors/app-error";

// The one authoritative modifier-selection validator. It is pure so Phase 9 order entry
// can reuse it with data loaded from the database. The UI never decides these rules.

export const SELECTION_TYPES = [
  "OPTIONAL_SINGLE",
  "REQUIRED_SINGLE",
  "OPTIONAL_MULTIPLE",
  "REQUIRED_MULTIPLE",
] as const;
export type SelectionType = (typeof SELECTION_TYPES)[number];

export type GroupRule = {
  selectionType: SelectionType;
  minimumSelections: number;
  maximumSelections: number | null;
};

/** Per-item overrides. All null means the group's own rule applies. */
export type AttachmentOverrides = {
  requiredOverride: boolean | null;
  minimumOverride: number | null;
  maximumOverride: number | null;
};

export type SelectionConstraints = { minimum: number; maximum: number | null };

const isSingle = (type: SelectionType) =>
  type === "OPTIONAL_SINGLE" || type === "REQUIRED_SINGLE";

/**
 * The rule that applies to one item's use of a group. An explicit minimum or maximum
 * override wins. Otherwise `requiredOverride` true means at least one selection and false
 * means none required. Single-choice groups never allow more than one.
 */
export function effectiveConstraints(
  group: GroupRule,
  overrides: AttachmentOverrides,
): SelectionConstraints {
  let minimum = group.minimumSelections;

  if (overrides.requiredOverride === true) {
    minimum = Math.max(minimum, 1);
  } else if (overrides.requiredOverride === false) {
    minimum = 0;
  }

  if (overrides.minimumOverride !== null) {
    minimum = overrides.minimumOverride;
  }

  let maximum = overrides.maximumOverride ?? group.maximumSelections;

  if (isSingle(group.selectionType)) {
    maximum = maximum === null ? 1 : Math.min(maximum, 1);
  }

  return { minimum, maximum };
}

/** Throws if a group's own rule, or an attachment's overrides, can't be satisfied. */
export function assertValidConstraints(
  group: GroupRule,
  overrides: AttachmentOverrides,
): SelectionConstraints {
  const constraints = effectiveConstraints(group, overrides);

  if (constraints.minimum < 0) {
    throw new BusinessRuleError("INVALID_SELECTION_RULE", "Minimum selections can't be negative.");
  }

  if (constraints.maximum !== null && constraints.maximum < constraints.minimum) {
    throw new BusinessRuleError(
      "INVALID_SELECTION_RULE",
      "Maximum selections can't be below the minimum.",
    );
  }

  if (constraints.maximum !== null && constraints.maximum < 1) {
    throw new BusinessRuleError(
      "INVALID_SELECTION_RULE",
      "Maximum selections must allow at least one choice.",
    );
  }

  if (
    isSingle(group.selectionType) &&
    overrides.maximumOverride !== null &&
    overrides.maximumOverride > 1
  ) {
    throw new BusinessRuleError(
      "INVALID_SELECTION_RULE",
      "A single-choice group can't allow more than one selection.",
    );
  }

  return constraints;
}

/** Checks a group definition on its own, as the editor and the services both need. */
export function assertValidGroupDefinition(group: GroupRule): void {
  const { selectionType, minimumSelections, maximumSelections } = group;

  if (minimumSelections < 0) {
    throw new BusinessRuleError("INVALID_SELECTION_RULE", "Minimum selections can't be negative.");
  }

  if (maximumSelections !== null && maximumSelections < minimumSelections) {
    throw new BusinessRuleError(
      "INVALID_SELECTION_RULE",
      "Maximum selections can't be below the minimum.",
    );
  }

  const valid =
    (selectionType === "OPTIONAL_SINGLE" && minimumSelections === 0 && maximumSelections === 1) ||
    (selectionType === "REQUIRED_SINGLE" && minimumSelections === 1 && maximumSelections === 1) ||
    (selectionType === "OPTIONAL_MULTIPLE" &&
      minimumSelections === 0 &&
      (maximumSelections === null || maximumSelections >= 1)) ||
    (selectionType === "REQUIRED_MULTIPLE" && minimumSelections >= 1);

  if (!valid) {
    throw new BusinessRuleError(
      "INVALID_SELECTION_RULE",
      `The minimum and maximum don't fit a ${selectionType.toLowerCase().replace("_", " ")} group.`,
    );
  }
}

export type SelectionGroup = {
  modifierGroupId: string;
  name: string;
  /** The group and its attachment to the item are both active. */
  active: boolean;
  constraints: SelectionConstraints;
  modifiers: { modifierId: string; name: string; active: boolean }[];
};

export type ProposedSelection = { modifierGroupId: string; modifierId: string };

export type SelectionViolation = {
  code:
    | "GROUP_NOT_ATTACHED"
    | "GROUP_INACTIVE"
    | "MODIFIER_NOT_IN_GROUP"
    | "MODIFIER_INACTIVE"
    | "DUPLICATE_SELECTION"
    | "BELOW_MINIMUM"
    | "ABOVE_MAXIMUM";
  modifierGroupId: string;
  modifierId?: string;
  message: string;
};

export function validateSelection(
  groups: readonly SelectionGroup[],
  selections: readonly ProposedSelection[],
): SelectionViolation[] {
  const violations: SelectionViolation[] = [];
  const byGroup = new Map(groups.map((group) => [group.modifierGroupId, group]));
  const counts = new Map<string, number>();
  const seen = new Set<string>();

  for (const selection of selections) {
    const group = byGroup.get(selection.modifierGroupId);

    if (!group) {
      violations.push({
        code: "GROUP_NOT_ATTACHED",
        modifierGroupId: selection.modifierGroupId,
        modifierId: selection.modifierId,
        message: "That modifier group isn't offered on this item.",
      });
      continue;
    }

    const key = `${selection.modifierGroupId}:${selection.modifierId}`;

    if (seen.has(key)) {
      violations.push({
        code: "DUPLICATE_SELECTION",
        modifierGroupId: group.modifierGroupId,
        modifierId: selection.modifierId,
        message: `A modifier can only be chosen once in ${group.name}.`,
      });
      continue;
    }

    seen.add(key);

    if (!group.active) {
      violations.push({
        code: "GROUP_INACTIVE",
        modifierGroupId: group.modifierGroupId,
        modifierId: selection.modifierId,
        message: `${group.name} isn't available.`,
      });
      continue;
    }

    const modifier = group.modifiers.find((entry) => entry.modifierId === selection.modifierId);

    if (!modifier) {
      violations.push({
        code: "MODIFIER_NOT_IN_GROUP",
        modifierGroupId: group.modifierGroupId,
        modifierId: selection.modifierId,
        message: `That modifier isn't part of ${group.name}.`,
      });
      continue;
    }

    if (!modifier.active) {
      violations.push({
        code: "MODIFIER_INACTIVE",
        modifierGroupId: group.modifierGroupId,
        modifierId: selection.modifierId,
        message: `${modifier.name} isn't available.`,
      });
      continue;
    }

    counts.set(group.modifierGroupId, (counts.get(group.modifierGroupId) ?? 0) + 1);
  }

  for (const group of groups) {
    if (!group.active) {
      continue;
    }

    const chosen = counts.get(group.modifierGroupId) ?? 0;

    if (chosen < group.constraints.minimum) {
      violations.push({
        code: "BELOW_MINIMUM",
        modifierGroupId: group.modifierGroupId,
        message: `Choose at least ${group.constraints.minimum} from ${group.name}.`,
      });
    }

    if (group.constraints.maximum !== null && chosen > group.constraints.maximum) {
      violations.push({
        code: "ABOVE_MAXIMUM",
        modifierGroupId: group.modifierGroupId,
        message: `Choose at most ${group.constraints.maximum} from ${group.name}.`,
      });
    }
  }

  return violations;
}

/** Throws the first violation as a business-rule error. */
export function assertValidSelection(
  groups: readonly SelectionGroup[],
  selections: readonly ProposedSelection[],
): void {
  const [first] = validateSelection(groups, selections);

  if (first) {
    throw new BusinessRuleError(first.code, first.message);
  }
}
