import { BusinessRuleError } from "@/shared/errors/app-error";

// Phase 36 part 5 (policy 9): bundle (prix-fixe and combo) rules. Pure, so they are unit-tested
// on their own.

export type BundleSlotFacts = {
  id: string;
  name: string;
  minimumChoices: number;
  maximumChoices: number;
  options: { menuItemId: string; upcharge: string }[];
};

/** A bundle can be sold while every slot still has at least its minimum of options. */
export function slotsFillable(slots: readonly BundleSlotFacts[]): boolean {
  return slots.length > 0 && slots.every((slot) => slot.options.length >= Math.max(slot.minimumChoices, 1) || slot.minimumChoices === 0);
}

export type BundleChoice = { slotId: string; menuItemId: string };

/**
 * Policy 9: the choices fill each slot with between its minimum and maximum of its offered
 * options, each option at most once per slot. Returns each choice's upcharge, in order.
 */
export function validateBundleChoices(slots: readonly BundleSlotFacts[], choices: readonly BundleChoice[]): string[] {
  const bySlot = new Map(slots.map((slot) => [slot.id, slot]));

  for (const choice of choices) {
    const slot = bySlot.get(choice.slotId);

    if (!slot) {
      throw new BusinessRuleError("BUNDLE_CHOICE_INVALID", "A choice is for a course this item doesn't have.");
    }

    if (!slot.options.some((option) => option.menuItemId === choice.menuItemId)) {
      throw new BusinessRuleError("BUNDLE_OPTION_UNAVAILABLE", `That choice for ${slot.name} isn't available right now.`);
    }
  }

  for (const slot of slots) {
    const chosen = choices.filter((choice) => choice.slotId === slot.id);

    if (chosen.length < slot.minimumChoices || chosen.length > slot.maximumChoices) {
      throw new BusinessRuleError(
        "BUNDLE_CHOICES_REQUIRED",
        slot.minimumChoices === slot.maximumChoices
          ? `Choose ${slot.minimumChoices} for ${slot.name}.`
          : `Choose ${slot.minimumChoices} to ${slot.maximumChoices} for ${slot.name}.`,
      );
    }

    if (new Set(chosen.map((choice) => choice.menuItemId)).size !== chosen.length) {
      throw new BusinessRuleError("BUNDLE_CHOICE_REPEATED", `Each choice for ${slot.name} is chosen once.`);
    }
  }

  return choices.map((choice) => bySlot.get(choice.slotId)!.options.find((option) => option.menuItemId === choice.menuItemId)!.upcharge);
}

/** Policy 9: what a bundle sets up: 1 to 10 slots, each with options, minimum ≤ maximum ≤ 10. */
export function assertBundleShape(
  slots: readonly { name: string; minimumChoices: number; maximumChoices: number; defaultCourse: number; options: readonly unknown[] }[],
): void {
  if (slots.length === 0 || slots.length > 10) {
    throw new BusinessRuleError("BUNDLE_SLOTS_INVALID", "A bundle has 1 to 10 courses.");
  }

  for (const slot of slots) {
    if (!slot.name.trim() || slot.name.trim().length > 60) {
      throw new BusinessRuleError("BUNDLE_SLOTS_INVALID", "Each course needs a name of up to 60 characters.");
    }

    if (slot.minimumChoices < 0 || slot.maximumChoices < 1 || slot.maximumChoices < slot.minimumChoices || slot.maximumChoices > 10) {
      throw new BusinessRuleError("BUNDLE_SLOTS_INVALID", `${slot.name}: choose a minimum and maximum from 0 to 10, the maximum at least 1.`);
    }

    if (slot.defaultCourse < 1 || slot.defaultCourse > 5) {
      throw new BusinessRuleError("BUNDLE_SLOTS_INVALID", `${slot.name}: the course is 1 to 5.`);
    }

    if (slot.options.length === 0) {
      throw new BusinessRuleError("BUNDLE_SLOTS_INVALID", `${slot.name} needs at least one choice.`);
    }
  }
}
