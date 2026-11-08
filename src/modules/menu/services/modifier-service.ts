import { and, asc, eq } from "drizzle-orm";

import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { updateVersioned } from "@/db/helpers/versioned-update";
import {
  menuItemModifierGroups,
  modifierGroupModifiers,
  modifierGroups,
  modifiers,
} from "@/db/schema";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";

import {
  assertValidConstraints,
  assertValidGroupDefinition,
  effectiveConstraints,
  type AttachmentOverrides,
  type GroupRule,
  type SelectionType,
} from "../rules/modifier-selection";
import type { PreparationEffectType } from "../types";
import { assertPermission, requireMenuItem } from "./access";

const codeTaken = (label: string) =>
  new ConflictError("CODE_TAKEN", `Another ${label} already uses that code.`);

// -------------------------------------------------------------------- groups

type GroupInput = {
  name: string;
  description: string | null;
  selectionType: SelectionType;
  minimumSelections: number;
  maximumSelections: number | null;
  displayOrder: number;
};

function groupRule(input: GroupInput): GroupRule {
  return {
    selectionType: input.selectionType,
    minimumSelections: input.minimumSelections,
    maximumSelections: input.maximumSelections,
  };
}

export async function listGroups(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "menu.view");

  const groups = await executor
    .select()
    .from(modifierGroups)
    .where(eq(modifierGroups.organizationId, actor.organizationId))
    .orderBy(asc(modifierGroups.displayOrder), asc(modifierGroups.name));
  const members = await executor
    .select({
      modifierGroupId: modifierGroupModifiers.modifierGroupId,
      modifierId: modifierGroupModifiers.modifierId,
      displayOrder: modifierGroupModifiers.displayOrder,
      active: modifierGroupModifiers.active,
    })
    .from(modifierGroupModifiers)
    .where(eq(modifierGroupModifiers.organizationId, actor.organizationId))
    .orderBy(asc(modifierGroupModifiers.displayOrder));

  return groups.map((group) => ({
    ...group,
    modifiers: members.filter((member) => member.modifierGroupId === group.id),
  }));
}

export async function createGroup(
  database: Database,
  actor: Actor,
  input: GroupInput & { code: string },
) {
  assertPermission(actor, "menu.modifiers.manage");
  assertValidGroupDefinition(groupRule(input));

  try {
    const [row] = await database
      .insert(modifierGroups)
      .values({ ...input, organizationId: actor.organizationId })
      .returning();

    return row!;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw codeTaken("modifier group");
    }

    throw error;
  }
}

/** Changing a group's rule must leave every item's overrides satisfiable. */
export async function updateGroup(
  database: Database,
  actor: Actor,
  groupId: string,
  input: GroupInput & { active: boolean; expectedVersion: number },
) {
  assertPermission(actor, "menu.modifiers.manage");
  assertValidGroupDefinition(groupRule(input));

  const { expectedVersion, ...values } = input;

  return withTransaction(database, async (transaction) => {
    const updated = await updateVersioned(transaction, modifierGroups, {
      id: groupId,
      organizationId: actor.organizationId,
      expectedVersion,
      values,
      label: "modifier group",
    });

    const attachments = await transaction
      .select()
      .from(menuItemModifierGroups)
      .where(eq(menuItemModifierGroups.modifierGroupId, groupId));

    for (const attachment of attachments) {
      assertValidConstraints(groupRule(input), attachment);
    }

    return updated;
  });
}

// ----------------------------------------------------------------- modifiers

type ModifierInput = {
  name: string;
  description: string | null;
  priceAdjustment: string;
  preparationEffectType: PreparationEffectType;
  preparationInstruction: string | null;
};

function normalizeModifier<Input extends ModifierInput>(input: Input): Input {
  let priceAdjustment: string;

  try {
    priceAdjustment = toScale(input.priceAdjustment, 2);
  } catch {
    throw new BusinessRuleError(
      "INVALID_PRICE",
      "A price adjustment is a number with at most two decimal places.",
    );
  }

  if (input.preparationEffectType === "INSTRUCTION" && !input.preparationInstruction) {
    throw new BusinessRuleError(
      "INSTRUCTION_REQUIRED",
      "An instruction modifier needs the instruction text.",
    );
  }

  return { ...input, priceAdjustment };
}

export async function listModifiers(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "menu.view");

  return executor
    .select()
    .from(modifiers)
    .where(eq(modifiers.organizationId, actor.organizationId))
    .orderBy(asc(modifiers.name));
}

export async function createModifier(
  database: Database,
  actor: Actor,
  input: ModifierInput & { code: string },
) {
  assertPermission(actor, "menu.modifiers.manage");

  const values = normalizeModifier(input);

  try {
    const [row] = await database
      .insert(modifiers)
      .values({ ...values, organizationId: actor.organizationId })
      .returning();

    return row!;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw codeTaken("modifier");
    }

    throw error;
  }
}

export async function updateModifier(
  database: Database,
  actor: Actor,
  modifierId: string,
  input: ModifierInput & { active: boolean; expectedVersion: number },
) {
  assertPermission(actor, "menu.modifiers.manage");

  const { expectedVersion, ...rest } = input;

  return updateVersioned(database, modifiers, {
    id: modifierId,
    organizationId: actor.organizationId,
    expectedVersion,
    values: normalizeModifier(rest),
    label: "modifier",
  });
}

/** Adds a modifier to a group, or changes its order or active state there. */
export async function setGroupModifier(
  database: Database,
  actor: Actor,
  groupId: string,
  input: { modifierId: string; displayOrder: number; active: boolean },
) {
  assertPermission(actor, "menu.modifiers.manage");

  return withTransaction(database, async (transaction) => {
    const [group] = await transaction
      .select({ id: modifierGroups.id })
      .from(modifierGroups)
      .where(
        and(
          eq(modifierGroups.id, groupId),
          eq(modifierGroups.organizationId, actor.organizationId),
        ),
      );
    const [modifier] = await transaction
      .select({ id: modifiers.id })
      .from(modifiers)
      .where(
        and(
          eq(modifiers.id, input.modifierId),
          eq(modifiers.organizationId, actor.organizationId),
        ),
      );

    if (!group) {
      throw new NotFoundError("modifier group");
    }

    if (!modifier) {
      throw new NotFoundError("modifier");
    }

    const [row] = await transaction
      .insert(modifierGroupModifiers)
      .values({
        organizationId: actor.organizationId,
        modifierGroupId: groupId,
        modifierId: input.modifierId,
        displayOrder: input.displayOrder,
        active: input.active,
      })
      .onConflictDoUpdate({
        target: [modifierGroupModifiers.modifierGroupId, modifierGroupModifiers.modifierId],
        set: { displayOrder: input.displayOrder, active: input.active, updatedAt: new Date() },
      })
      .returning();

    return row!;
  });
}

// ------------------------------------------------------ item group attachments

type AttachmentInput = AttachmentOverrides & { displayOrder: number };

async function requireGroup(executor: DatabaseExecutor, actor: Actor, groupId: string) {
  const [group] = await executor
    .select()
    .from(modifierGroups)
    .where(
      and(
        eq(modifierGroups.id, groupId),
        eq(modifierGroups.organizationId, actor.organizationId),
      ),
    );

  if (!group) {
    throw new NotFoundError("modifier group");
  }

  return { ...group, selectionType: group.selectionType as SelectionType };
}

export async function listItemAttachments(
  executor: DatabaseExecutor,
  actor: Actor,
  menuItemId: string,
) {
  assertPermission(actor, "menu.view");
  await requireMenuItem(executor, actor, menuItemId);

  const rows = await executor
    .select({ attachment: menuItemModifierGroups, group: modifierGroups })
    .from(menuItemModifierGroups)
    .innerJoin(modifierGroups, eq(modifierGroups.id, menuItemModifierGroups.modifierGroupId))
    .where(eq(menuItemModifierGroups.menuItemId, menuItemId))
    .orderBy(asc(menuItemModifierGroups.displayOrder));

  return rows.map(({ attachment, group }) => ({
    ...attachment,
    group: { id: group.id, code: group.code, name: group.name, active: group.active },
    constraints: effectiveConstraints(
      { ...group, selectionType: group.selectionType as SelectionType },
      attachment,
    ),
  }));
}

/** Offers a modifier group on a menu item, with optional per-item rule overrides. */
export async function attachGroup(
  database: Database,
  actor: Actor,
  menuItemId: string,
  input: AttachmentInput & { modifierGroupId: string },
) {
  assertPermission(actor, "menu.edit");

  return withTransaction(database, async (transaction) => {
    await requireMenuItem(transaction, actor, menuItemId);

    const group = await requireGroup(transaction, actor, input.modifierGroupId);

    assertValidConstraints(group, input);

    try {
      const [row] = await transaction
        .insert(menuItemModifierGroups)
        .values({ ...input, menuItemId, organizationId: actor.organizationId })
        .returning();

      return row!;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          "GROUP_ALREADY_ATTACHED",
          "That group is already attached to this item. Edit or reactivate it instead.",
        );
      }

      throw error;
    }
  });
}

export async function updateAttachment(
  database: Database,
  actor: Actor,
  attachmentId: string,
  input: AttachmentInput & { active: boolean; expectedVersion: number },
) {
  assertPermission(actor, "menu.edit");

  return withTransaction(database, async (transaction) => {
    const [existing] = await transaction
      .select({ modifierGroupId: menuItemModifierGroups.modifierGroupId })
      .from(menuItemModifierGroups)
      .where(
        and(
          eq(menuItemModifierGroups.id, attachmentId),
          eq(menuItemModifierGroups.organizationId, actor.organizationId),
        ),
      );

    if (!existing) {
      throw new NotFoundError("modifier group attachment");
    }

    assertValidConstraints(await requireGroup(transaction, actor, existing.modifierGroupId), input);

    const { expectedVersion, ...values } = input;

    return updateVersioned(transaction, menuItemModifierGroups, {
      id: attachmentId,
      organizationId: actor.organizationId,
      expectedVersion,
      values,
      label: "modifier group attachment",
    });
  });
}
