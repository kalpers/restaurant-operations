import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { modifierGroups } from "@/db/schema";
import {
  attachGroup,
  createGroup,
  createModifier,
  listGroups,
  listItemAttachments,
  setGroupModifier,
  updateAttachment,
  updateGroup,
  updateModifier,
} from "@/modules/menu/services/modifier-service";
import {
  priceProspectiveItem,
  validateModifierSelection,
} from "@/modules/menu/services/selection-service";
import { AuthorizationError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import {
  attachGroupWith,
  createMenuScenario,
  groupFixture,
  itemFixture,
  modifierFixture,
  priceFixture,
  sellableItem,
  uniqueCode,
  type MenuScenario,
} from "../../fixtures/menu-fixtures";

const database = () => getDatabase();

describe("modifiers", () => {
  let scenario: MenuScenario;

  beforeEach(async () => {
    scenario = await createMenuScenario(database());
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const pick = (modifierGroupId: string, ...modifierIds: string[]) =>
    modifierIds.map((modifierId) => ({ modifierGroupId, modifierId }));

  describe("groups and modifiers", () => {
    it("creates a group and modifiers and lists membership", async () => {
      const group = await groupFixture(database(), scenario.admin, "REQUIRED_SINGLE");
      const medium = await modifierFixture(database(), scenario.admin, { name: "Medium" });

      await setGroupModifier(database(), scenario.admin, group.id, {
        modifierId: medium.id,
        displayOrder: 1,
        active: true,
      });

      const [listed] = (await listGroups(database(), scenario.viewer)).filter(
        (row) => row.id === group.id,
      );

      expect(listed?.modifiers.map((member) => member.modifierId)).toEqual([medium.id]);
    });

    it("reuses one modifier across several groups", async () => {
      const first = await groupFixture(database(), scenario.admin);
      const second = await groupFixture(database(), scenario.admin);
      const modifier = await modifierFixture(database(), scenario.admin);

      for (const group of [first, second]) {
        await setGroupModifier(database(), scenario.admin, group.id, {
          modifierId: modifier.id,
          displayOrder: 0,
          active: true,
        });
      }

      const groups = await listGroups(database(), scenario.viewer);

      expect(
        groups.filter((group) => group.modifiers.some((member) => member.modifierId === modifier.id)),
      ).toHaveLength(2);
    });

    it("rejects invalid minimum and maximum rules", async () => {
      const base = {
        name: "Bad",
        description: null,
        displayOrder: 0,
      };
      const attempt = (rule: {
        selectionType: "OPTIONAL_SINGLE" | "REQUIRED_MULTIPLE" | "OPTIONAL_MULTIPLE";
        minimumSelections: number;
        maximumSelections: number | null;
      }) => createGroup(database(), scenario.admin, { ...base, code: uniqueCode("GRP"), ...rule });

      await expect(
        attempt({ selectionType: "REQUIRED_MULTIPLE", minimumSelections: 3, maximumSelections: 2 }),
      ).rejects.toMatchObject({ code: "INVALID_SELECTION_RULE" });
      await expect(
        attempt({ selectionType: "OPTIONAL_MULTIPLE", minimumSelections: -1, maximumSelections: null }),
      ).rejects.toMatchObject({ code: "INVALID_SELECTION_RULE" });
      await expect(
        attempt({ selectionType: "OPTIONAL_SINGLE", minimumSelections: 0, maximumSelections: 4 }),
      ).rejects.toMatchObject({ code: "INVALID_SELECTION_RULE" });
    });

    it("enforces selection rules in the database as a last line", async () => {
      await expect(
        database().insert(modifierGroups).values({
          organizationId: scenario.organizationId,
          code: uniqueCode("GRP"),
          name: "Raw",
          selectionType: "OPTIONAL_SINGLE",
          minimumSelections: 2,
          maximumSelections: 1,
        }),
      ).rejects.toThrow();
    });

    it("requires instruction text for an instruction modifier", async () => {
      await expect(
        createModifier(database(), scenario.admin, {
          code: uniqueCode("MOD"),
          name: "Well Done",
          description: null,
          priceAdjustment: "0.00",
          preparationEffectType: "INSTRUCTION",
          preparationInstruction: null,
        }),
      ).rejects.toMatchObject({ code: "INSTRUCTION_REQUIRED" });

      await expect(
        modifierFixture(database(), scenario.admin, {
          preparationEffectType: "INSTRUCTION",
          preparationInstruction: "Cook well done",
        }),
      ).resolves.toMatchObject({ preparationEffectType: "INSTRUCTION" });
    });

    it("stores price adjustments as exact decimals and rejects extra precision", async () => {
      const modifier = await modifierFixture(database(), scenario.admin, {
        priceAdjustment: "1.50",
      });

      expect(modifier.priceAdjustment).toBe("1.50");
      await expect(
        modifierFixture(database(), scenario.admin, { priceAdjustment: "1.505" }),
      ).rejects.toMatchObject({ code: "INVALID_PRICE" });
    });

    it("rejects a duplicate code and a stale update", async () => {
      const modifier = await modifierFixture(database(), scenario.admin);

      await expect(
        createModifier(database(), scenario.admin, {
          code: modifier.code,
          name: "Dup",
          description: null,
          priceAdjustment: "0.00",
          preparationEffectType: "NONE",
          preparationInstruction: null,
        }),
      ).rejects.toMatchObject({ code: "CODE_TAKEN" });

      const edit = (name: string) =>
        updateModifier(database(), scenario.admin, modifier.id, {
          name,
          description: null,
          priceAdjustment: "0.00",
          preparationEffectType: "NONE",
          preparationInstruction: null,
          active: true,
          expectedVersion: modifier.version,
        });

      await edit("A");
      await expect(edit("B")).rejects.toBeInstanceOf(ConcurrencyError);
    });

    it("refuses cross-organization membership", async () => {
      const group = await groupFixture(database(), scenario.admin);
      const foreignModifier = await modifierFixture(database(), scenario.other);

      await expect(
        setGroupModifier(database(), scenario.admin, group.id, {
          modifierId: foreignModifier.id,
          displayOrder: 0,
          active: true,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("attaching groups to items", () => {
    it("attaches a group and reports its effective constraints", async () => {
      const item = await itemFixture(database(), scenario.admin);
      const modifier = await modifierFixture(database(), scenario.admin);
      const { group } = await attachGroupWith(
        database(),
        scenario.admin,
        item.id,
        "REQUIRED_SINGLE",
        [modifier.id],
      );

      const [attached] = await listItemAttachments(database(), scenario.viewer, item.id);

      expect(attached).toMatchObject({
        modifierGroupId: group.id,
        constraints: { minimum: 1, maximum: 1 },
      });
    });

    it("rejects attaching the same group twice", async () => {
      const item = await itemFixture(database(), scenario.admin);
      const group = await groupFixture(database(), scenario.admin);
      const input = {
        modifierGroupId: group.id,
        displayOrder: 0,
        requiredOverride: null,
        minimumOverride: null,
        maximumOverride: null,
      };

      await attachGroup(database(), scenario.admin, item.id, input);
      await expect(
        attachGroup(database(), scenario.admin, item.id, input),
      ).rejects.toMatchObject({ code: "GROUP_ALREADY_ATTACHED" });
    });

    it("refuses a group from another organization, and an unsatisfiable override", async () => {
      const item = await itemFixture(database(), scenario.admin);
      const foreign = await groupFixture(database(), scenario.other);
      const group = await groupFixture(database(), scenario.admin, "OPTIONAL_MULTIPLE");
      const input = {
        displayOrder: 0,
        requiredOverride: null,
        minimumOverride: null,
        maximumOverride: null,
      };

      await expect(
        attachGroup(database(), scenario.admin, item.id, { ...input, modifierGroupId: foreign.id }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        attachGroup(database(), scenario.admin, item.id, {
          ...input,
          modifierGroupId: group.id,
          minimumOverride: 5,
          maximumOverride: 2,
        }),
      ).rejects.toMatchObject({ code: "INVALID_SELECTION_RULE" });
    });

    it("refuses to attach another organization's item", async () => {
      const foreignItem = await itemFixture(database(), scenario.other);
      const group = await groupFixture(database(), scenario.admin);

      await expect(
        attachGroup(database(), scenario.admin, foreignItem.id, {
          modifierGroupId: group.id,
          displayOrder: 0,
          requiredOverride: null,
          minimumOverride: null,
          maximumOverride: null,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("keeps an item's overrides satisfiable when the group's rule changes", async () => {
      const item = await itemFixture(database(), scenario.admin);
      const group = await groupFixture(database(), scenario.admin, "OPTIONAL_MULTIPLE", {
        maximumSelections: 5,
      });

      await attachGroup(database(), scenario.admin, item.id, {
        modifierGroupId: group.id,
        displayOrder: 0,
        requiredOverride: null,
        minimumOverride: 3,
        maximumOverride: null,
      });

      await expect(
        updateGroup(database(), scenario.admin, group.id, {
          name: group.name,
          description: null,
          selectionType: "OPTIONAL_MULTIPLE",
          minimumSelections: 0,
          maximumSelections: 2,
          displayOrder: 0,
          active: true,
          expectedVersion: group.version,
        }),
      ).rejects.toMatchObject({ code: "INVALID_SELECTION_RULE" });
    });
  });

  describe("server-side selection rules", () => {
    it("enforces required-single, optional-multiple limits and inactive choices", async () => {
      const item = await itemFixture(database(), scenario.admin);
      const [medium, rare, bacon, pickles, tomato] = await Promise.all(
        ["Medium", "Rare", "Bacon", "Pickles", "Tomato"].map((name) =>
          modifierFixture(database(), scenario.admin, { name }),
        ),
      );
      const temp = await attachGroupWith(database(), scenario.admin, item.id, "REQUIRED_SINGLE", [
        medium!.id,
        rare!.id,
      ]);
      const addons = await attachGroupWith(
        database(),
        scenario.admin,
        item.id,
        "OPTIONAL_MULTIPLE",
        [bacon!.id, pickles!.id, tomato!.id],
        { maximumSelections: 2 },
      );
      const codes = async (selections: ReturnType<typeof pick>) =>
        (
          await validateModifierSelection(database(), scenario.viewer, {
            menuItemId: item.id,
            selections,
          })
        ).map((violation) => violation.code);

      expect(await codes([])).toEqual(["BELOW_MINIMUM"]);
      expect(await codes(pick(temp.group.id, medium!.id))).toEqual([]);
      expect(await codes(pick(temp.group.id, medium!.id, rare!.id))).toEqual(["ABOVE_MAXIMUM"]);
      expect(
        await codes([
          ...pick(temp.group.id, rare!.id),
          ...pick(addons.group.id, bacon!.id, pickles!.id),
        ]),
      ).toEqual([]);
      expect(
        await codes([
          ...pick(temp.group.id, rare!.id),
          ...pick(addons.group.id, bacon!.id, pickles!.id, tomato!.id),
        ]),
      ).toEqual(["ABOVE_MAXIMUM"]);

      // An inactive modifier is refused.
      await updateModifier(database(), scenario.admin, bacon!.id, {
        name: bacon!.name,
        description: null,
        priceAdjustment: "0.00",
        preparationEffectType: "NONE",
        preparationInstruction: null,
        active: false,
        expectedVersion: bacon!.version,
      });
      expect(
        await codes([...pick(temp.group.id, rare!.id), ...pick(addons.group.id, bacon!.id)]),
      ).toEqual(["MODIFIER_INACTIVE"]);
    });

    it("refuses a group that is not attached to the item", async () => {
      const item = await itemFixture(database(), scenario.admin);
      const modifier = await modifierFixture(database(), scenario.admin);
      const unattached = await groupFixture(database(), scenario.admin);

      await setGroupModifier(database(), scenario.admin, unattached.id, {
        modifierId: modifier.id,
        displayOrder: 0,
        active: true,
      });

      const violations = await validateModifierSelection(database(), scenario.viewer, {
        menuItemId: item.id,
        selections: pick(unattached.id, modifier.id),
      });

      expect(violations.map((violation) => violation.code)).toEqual(["GROUP_NOT_ATTACHED"]);
    });

    it("applies the item's override instead of the group's own rule", async () => {
      const item = await itemFixture(database(), scenario.admin);
      const [a, b] = await Promise.all([
        modifierFixture(database(), scenario.admin),
        modifierFixture(database(), scenario.admin),
      ]);
      const group = await groupFixture(database(), scenario.admin, "OPTIONAL_MULTIPLE", {
        maximumSelections: 3,
      });

      for (const modifier of [a, b]) {
        await setGroupModifier(database(), scenario.admin, group.id, {
          modifierId: modifier.id,
          displayOrder: 0,
          active: true,
        });
      }

      const attachment = await attachGroup(database(), scenario.admin, item.id, {
        modifierGroupId: group.id,
        displayOrder: 0,
        requiredOverride: null,
        minimumOverride: null,
        maximumOverride: 1,
      });
      const check = async () =>
        (
          await validateModifierSelection(database(), scenario.viewer, {
            menuItemId: item.id,
            selections: pick(group.id, a.id, b.id),
          })
        ).map((violation) => violation.code);

      expect(await check()).toEqual(["ABOVE_MAXIMUM"]);

      await updateAttachment(database(), scenario.admin, attachment.id, {
        displayOrder: 0,
        requiredOverride: null,
        minimumOverride: null,
        maximumOverride: null,
        active: true,
        expectedVersion: attachment.version,
      });

      expect(await check()).toEqual([]);
    });

    it("stops requiring a group that has been deactivated", async () => {
      const item = await itemFixture(database(), scenario.admin);
      const modifier = await modifierFixture(database(), scenario.admin);
      const { group } = await attachGroupWith(
        database(),
        scenario.admin,
        item.id,
        "REQUIRED_SINGLE",
        [modifier.id],
      );
      const violations = () =>
        validateModifierSelection(database(), scenario.viewer, {
          menuItemId: item.id,
          selections: [],
        });

      expect(await violations()).toHaveLength(1);

      await updateGroup(database(), scenario.admin, group.id, {
        name: group.name,
        description: null,
        selectionType: "REQUIRED_SINGLE",
        minimumSelections: 1,
        maximumSelections: 1,
        displayOrder: 0,
        active: false,
        expectedVersion: group.version,
      });

      expect(await violations()).toEqual([]);
    });
  });

  describe("prospective pricing", () => {
    it("adds modifier adjustments to the resolved price with exact arithmetic", async () => {
      const { item } = await sellableItem(database(), scenario.admin, { price: "14.99" });
      const bacon = await modifierFixture(database(), scenario.admin, { priceAdjustment: "2.00" });
      const pickles = await modifierFixture(database(), scenario.admin, { priceAdjustment: "1.50" });
      const wellDone = await modifierFixture(database(), scenario.admin, {
        priceAdjustment: "0.00",
        preparationEffectType: "INSTRUCTION",
        preparationInstruction: "Well done",
      });
      const addons = await attachGroupWith(database(), scenario.admin, item.id, "OPTIONAL_MULTIPLE", [
        bacon.id,
        pickles.id,
        wellDone.id,
      ]);

      const quote = (...ids: string[]) =>
        priceProspectiveItem(database(), scenario.viewer, {
          menuItemId: item.id,
          selections: pick(addons.group.id, ...ids),
        });

      expect((await quote()).amount).toBe("14.99");
      expect((await quote(bacon.id)).amount).toBe("16.99");
      expect((await quote(bacon.id, pickles.id)).amount).toBe("18.49");
      expect((await quote(wellDone.id)).amount).toBe("14.99");
      expect(await quote(bacon.id)).toMatchObject({
        basePrice: "14.99",
        priceScope: "ORGANIZATION",
      });
    });

    it("refuses an invalid selection, an unpriced item and an unavailable item", async () => {
      const item = await itemFixture(database(), scenario.admin);
      const modifier = await modifierFixture(database(), scenario.admin);

      await attachGroupWith(database(), scenario.admin, item.id, "REQUIRED_SINGLE", [modifier.id]);
      await expect(
        priceProspectiveItem(database(), scenario.viewer, { menuItemId: item.id, selections: [] }),
      ).rejects.toMatchObject({ code: "NO_PRICE" });

      await priceFixture(database(), scenario.admin, item.id, "10.00");
      await expect(
        priceProspectiveItem(database(), scenario.viewer, { menuItemId: item.id, selections: [] }),
      ).rejects.toMatchObject({ code: "BELOW_MINIMUM" });
    });
  });

  describe("authorization", () => {
    it("requires menu.modifiers.manage to define groups and modifiers", async () => {
      await expect(groupFixture(database(), scenario.viewer)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      await expect(modifierFixture(database(), scenario.viewer)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });

    it("requires menu.edit to attach a group to an item", async () => {
      const item = await itemFixture(database(), scenario.admin);
      const group = await groupFixture(database(), scenario.admin);

      await expect(
        attachGroup(database(), scenario.viewer, item.id, {
          modifierGroupId: group.id,
          displayOrder: 0,
          requiredOverride: null,
          minimumOverride: null,
          maximumOverride: null,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("requires menu.view to validate a selection", async () => {
      const item = await itemFixture(database(), scenario.admin);

      await expect(
        validateModifierSelection(database(), scenario.outsider, {
          menuItemId: item.id,
          selections: [],
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });
  });
});
