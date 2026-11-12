// Phase 21 allergen labels (policies 11 and 12). Pure rules: the order screen, the menu item
// page and SEND all build an item's label with `resolveItemAllergens`, from the same final
// requirements SEND consumes, so the label shown is the label snapshotted.

export type AllergenKind = "CONTAINS" | "MAY_CONTAIN";
export type AllergenSource = "DERIVED" | "DECLARED";
export type AllergySeverity = "SEVERE" | "ALLERGY";

export type AllergenInfo = { id: string; code: string; name: string };

export type LabelAllergen = AllergenInfo & { kind: AllergenKind; source: AllergenSource };

export type AllergenLabel = {
  allergens: LabelAllergen[];
  /** Some ingredient (or the item itself, with no ingredients) hasn't had its allergens reviewed. */
  incomplete: boolean;
};

export type LabelFacts = {
  /** Inventory items left after the recipe and modifier effects, with a quantity above zero. */
  ingredientIds: readonly string[];
  /** Allergen IDs tagged on each inventory item. */
  ingredientAllergens: ReadonlyMap<string, readonly string[]>;
  /** Inventory items whose allergens someone has reviewed. */
  reviewedIngredientIds: ReadonlySet<string>;
  /** Allergens the menu item declares by hand. */
  declared: readonly { allergenId: string; kind: AllergenKind }[];
  /** Whether the menu item's declarations have been reviewed (saved, even empty). */
  declarationsReviewed: boolean;
  /** Active and inactive allergens by ID, for codes and names. */
  allergenInfo: ReadonlyMap<string, AllergenInfo>;
};

const KIND_RANK: Record<AllergenKind, number> = { MAY_CONTAIN: 0, CONTAINS: 1 };

/**
 * One item's label. CONTAINS wins over MAY_CONTAIN for the same allergen, and a derived
 * allergen wins over a declared one of the same kind. The label is incomplete when any
 * ingredient isn't reviewed, or when the item has no ingredients and its declarations aren't.
 */
export function resolveItemAllergens(facts: LabelFacts): AllergenLabel {
  const found = new Map<string, { kind: AllergenKind; source: AllergenSource }>();

  function add(allergenId: string, kind: AllergenKind, source: AllergenSource) {
    const existing = found.get(allergenId);

    if (
      !existing ||
      KIND_RANK[kind] > KIND_RANK[existing.kind] ||
      (kind === existing.kind && source === "DERIVED" && existing.source === "DECLARED")
    ) {
      found.set(allergenId, { kind, source });
    }
  }

  for (const ingredientId of facts.ingredientIds) {
    for (const allergenId of facts.ingredientAllergens.get(ingredientId) ?? []) {
      add(allergenId, "CONTAINS", "DERIVED");
    }
  }

  for (const declaration of facts.declared) {
    add(declaration.allergenId, declaration.kind, "DECLARED");
  }

  const unreviewedIngredient = facts.ingredientIds.some((id) => !facts.reviewedIngredientIds.has(id));
  const incomplete = unreviewedIngredient || (facts.ingredientIds.length === 0 && !facts.declarationsReviewed);
  const allergens = [...found.entries()].flatMap(([allergenId, entry]) => {
    const info = facts.allergenInfo.get(allergenId);

    return info ? [{ ...info, ...entry }] : [];
  });

  allergens.sort((left, right) => left.name.localeCompare(right.name) || left.code.localeCompare(right.code));

  return { allergens, incomplete };
}

export type RecordedAllergy = { allergenId: string; code: string; name: string; severity: AllergySeverity };

export type AllergenConflict = {
  itemId: string;
  /** The order's allergies this item's label matches. */
  matched: (RecordedAllergy & { kind: AllergenKind })[];
  /** The label is incomplete, so the item may hold any of the order's allergens. */
  incompleteLabel: boolean;
  severity: AllergySeverity;
};

function highest(severities: readonly AllergySeverity[]): AllergySeverity {
  return severities.includes("SEVERE") ? "SEVERE" : "ALLERGY";
}

/**
 * The items whose label conflicts with the order's recorded allergies (policy 12): a matched
 * allergen of either kind, or an incomplete label while the order has any allergy.
 */
export function findAllergenConflicts(
  items: readonly { itemId: string; label: AllergenLabel }[],
  allergies: readonly RecordedAllergy[],
): AllergenConflict[] {
  if (allergies.length === 0) {
    return [];
  }

  const byAllergen = new Map(allergies.map((allergy) => [allergy.allergenId, allergy]));

  return items.flatMap(({ itemId, label }) => {
    const matched = label.allergens.flatMap((allergen) => {
      const allergy = byAllergen.get(allergen.id);

      return allergy ? [{ ...allergy, kind: allergen.kind }] : [];
    });

    if (matched.length === 0 && !label.incomplete) {
      return [];
    }

    // An incomplete label may hold any of the order's allergies, so all of them count.
    const counted = label.incomplete ? allergies : matched;

    return [
      {
        itemId,
        matched,
        incompleteLabel: label.incomplete,
        severity: highest(counted.map((entry) => entry.severity)),
      },
    ];
  });
}

/**
 * The ticket and acknowledgment text, such as "ALLERGY: Peanuts (severe), Milk". With an
 * incomplete label and nothing matched it names the order's allergies to check for.
 */
export function describeConflict(
  conflict: Pick<AllergenConflict, "matched" | "incompleteLabel">,
  allergies: readonly RecordedAllergy[],
): string {
  const severe = (entry: { severity: AllergySeverity }) => (entry.severity === "SEVERE" ? " (severe)" : "");
  const parts = conflict.matched.map(
    (entry) => `${entry.name}${severe(entry)}${entry.kind === "MAY_CONTAIN" ? " (may contain)" : ""}`,
  );

  if (conflict.incompleteLabel) {
    const matchedIds = new Set(conflict.matched.map((entry) => entry.allergenId));
    const unchecked = allergies.filter((entry) => !matchedIds.has(entry.allergenId));

    if (unchecked.length > 0) {
      parts.push(`check for ${unchecked.map((entry) => `${entry.name}${severe(entry)}`).join(", ")}`);
    }

    parts.push("allergens not fully reviewed");
  }

  return `ALLERGY: ${parts.join("; ")}`;
}
