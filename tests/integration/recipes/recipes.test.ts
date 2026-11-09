import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { recipes, recipeVersions } from "@/db/schema";
import {
  createDraftRevision,
  createRecipe,
  deleteDraftRevision,
  getRecipeDetail,
  listRecipes,
  publishRevision,
  resolveEffectiveRevision,
  resolveEffectiveRevisionForMenuItem,
  retireRevision,
  updateDraftRevision,
  updateRecipe,
} from "@/modules/recipes/services/recipe-service";
import { convertUnits, listUnits } from "@/modules/recipes/services/unit-service";
import { AuthorizationError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import {
  createMenuScenario,
  itemFixture,
  uniqueCode,
  unitId,
  type MenuScenario,
} from "../../fixtures/menu-fixtures";

const database = () => getDatabase();
const at = (iso: string) => new Date(iso);

describe("recipes", () => {
  let scenario: MenuScenario;

  beforeEach(async () => {
    scenario = await createMenuScenario(database());
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const recipeFixture = (menuItemId: string | null = null) =>
    createRecipe(database(), scenario.admin, {
      code: uniqueCode("RCP"),
      name: "Cheeseburger preparation",
      description: null,
      menuItemId,
    });

  const draft = async (recipeId: string, yieldQuantity = "1", notes: string | null = null) =>
    createDraftRevision(database(), scenario.admin, recipeId, {
      yieldQuantity,
      yieldUnitId: await unitId(database(), "EACH"),
      preparationNotes: notes,
    });

  describe("identity", () => {
    it("creates a durable recipe identity, optionally linked to a menu item", async () => {
      const item = await itemFixture(database(), scenario.admin);
      const linked = await recipeFixture(item.id);
      const unlinked = await recipeFixture();

      expect(linked.menuItemId).toBe(item.id);
      expect(unlinked.menuItemId).toBeNull();
      expect((await listRecipes(database(), scenario.admin)).length).toBeGreaterThanOrEqual(2);
    });

    it("keeps a menu item usable without a recipe", async () => {
      const item = await itemFixture(database(), scenario.admin);

      expect(
        await resolveEffectiveRevisionForMenuItem(
          database(),
          scenario.organizationId,
          item.id,
          new Date(),
        ),
      ).toBeNull();
    });

    it("allows one recipe per menu item and a unique code per organization", async () => {
      const item = await itemFixture(database(), scenario.admin);

      await recipeFixture(item.id);
      await expect(recipeFixture(item.id)).rejects.toMatchObject({
        code: "CODE_OR_ITEM_TAKEN",
      });

      const code = uniqueCode("RCP");
      const input = { code, name: "A", description: null, menuItemId: null };

      await createRecipe(database(), scenario.admin, input);
      await expect(createRecipe(database(), scenario.admin, input)).rejects.toMatchObject({
        code: "CODE_TAKEN",
      });
    });

    it("refuses another organization's menu item", async () => {
      const foreignItem = await itemFixture(database(), scenario.other);

      await expect(recipeFixture(foreignItem.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("enforces organization ownership in the database", async () => {
      const foreignItem = await itemFixture(database(), scenario.other);

      await expect(
        database().insert(recipes).values({
          organizationId: scenario.organizationId,
          menuItemId: foreignItem.id,
          code: uniqueCode("RCP"),
          name: "Raw",
        }),
      ).rejects.toThrow();
    });

    it("rejects a stale update and deactivates instead of deleting", async () => {
      const recipe = await recipeFixture();
      const edit = (active: boolean) =>
        updateRecipe(database(), scenario.admin, recipe.id, {
          name: recipe.name,
          description: null,
          menuItemId: null,
          active,
          expectedVersion: recipe.version,
        });

      expect((await edit(false)).active).toBe(false);
      await expect(edit(true)).rejects.toBeInstanceOf(ConcurrencyError);
    });
  });

  describe("revisions", () => {
    it("numbers revisions from one and keeps drafts without an interval", async () => {
      const recipe = await recipeFixture();
      const first = await draft(recipe.id);
      const second = await draft(recipe.id);

      expect([first.revisionNumber, second.revisionNumber]).toEqual([1, 2]);
      expect(first).toMatchObject({
        status: "DRAFT",
        effectiveFrom: null,
        effectiveTo: null,
        yieldQuantity: "1.0000",
      });
    });

    it("stores yield as an exact fixed-precision decimal string", async () => {
      const recipe = await recipeFixture();
      const revision = await draft(recipe.id, "64.5");

      expect(revision.yieldQuantity).toBe("64.5000");
      await expect(draft(recipe.id, "0")).rejects.toMatchObject({ code: "INVALID_YIELD" });
      await expect(draft(recipe.id, "-2")).rejects.toMatchObject({ code: "INVALID_YIELD" });
      await expect(draft(recipe.id, "1.00001")).rejects.toMatchObject({ code: "INVALID_YIELD" });
    });

    it("edits a draft but never a published revision", async () => {
      const recipe = await recipeFixture();
      const revision = await draft(recipe.id);
      const edited = await updateDraftRevision(database(), scenario.admin, recipe.id, revision.id, {
        yieldQuantity: "2",
        yieldUnitId: null,
        preparationNotes: "Grill 4 minutes per side",
        expectedVersion: revision.version,
      });

      expect(edited).toMatchObject({ yieldQuantity: "2.0000", yieldUnitId: null });

      const published = await publishRevision(
        database(),
        scenario.admin,
        recipe.id,
        revision.id,
        { effectiveFrom: null, expectedVersion: edited.version },
        at("2026-01-01T00:00:00Z"),
      );

      await expect(
        updateDraftRevision(database(), scenario.admin, recipe.id, revision.id, {
          yieldQuantity: "9",
          yieldUnitId: null,
          preparationNotes: "Changed",
          expectedVersion: published.version,
        }),
      ).rejects.toMatchObject({ code: "REVISION_NOT_EDITABLE" });
    });

    it("freezes published content in the database too", async () => {
      const recipe = await recipeFixture();
      const revision = await draft(recipe.id);

      await publishRevision(
        database(),
        scenario.admin,
        recipe.id,
        revision.id,
        { effectiveFrom: null, expectedVersion: revision.version },
        at("2026-01-01T00:00:00Z"),
      );

      await expect(
        database()
          .update(recipeVersions)
          .set({ yieldQuantity: "99.0000" })
          .where(eq(recipeVersions.id, revision.id)),
      ).rejects.toThrow();
      await expect(
        database()
          .update(recipeVersions)
          .set({ preparationNotes: "sneaky" })
          .where(eq(recipeVersions.id, revision.id)),
      ).rejects.toThrow();
      await expect(
        database().update(recipeVersions).set({ status: "DRAFT", effectiveFrom: null, effectiveTo: null }).where(eq(recipeVersions.id, revision.id)),
      ).rejects.toThrow();
      await expect(
        database().delete(recipeVersions).where(eq(recipeVersions.id, revision.id)),
      ).rejects.toThrow();
    });

    it("publishes a second revision, closing the first and preserving it", async () => {
      const recipe = await recipeFixture();
      const first = await draft(recipe.id, "1", "v1");
      const second = await draft(recipe.id, "2", "v2");

      await publishRevision(
        database(),
        scenario.admin,
        recipe.id,
        first.id,
        { effectiveFrom: null, expectedVersion: first.version },
        at("2026-01-01T00:00:00Z"),
      );
      await publishRevision(
        database(),
        scenario.admin,
        recipe.id,
        second.id,
        { effectiveFrom: null, expectedVersion: second.version },
        at("2026-06-01T00:00:00Z"),
      );

      const detail = await getRecipeDetail(
        database(),
        scenario.admin,
        recipe.id,
        at("2026-07-01T00:00:00Z"),
      );
      const byNumber = new Map(detail.revisions.map((row) => [row.revisionNumber, row]));

      expect(byNumber.get(1)).toMatchObject({
        status: "PUBLISHED",
        preparationNotes: "v1",
        yieldQuantity: "1.0000",
        effectiveFrom: at("2026-01-01T00:00:00Z"),
        effectiveTo: at("2026-06-01T00:00:00Z"),
      });
      expect(byNumber.get(2)).toMatchObject({
        status: "PUBLISHED",
        preparationNotes: "v2",
        effectiveFrom: at("2026-06-01T00:00:00Z"),
        effectiveTo: null,
      });
      expect(detail.effectiveRevisionId).toBe(second.id);
    });

    it("resolves the revision in effect at an instant, with a half-open boundary", async () => {
      const recipe = await recipeFixture();
      const first = await draft(recipe.id);
      const second = await draft(recipe.id);

      await publishRevision(database(), scenario.admin, recipe.id, first.id, { effectiveFrom: null, expectedVersion: first.version }, at("2026-01-01T00:00:00Z"));
      await publishRevision(database(), scenario.admin, recipe.id, second.id, { effectiveFrom: null, expectedVersion: second.version }, at("2026-06-01T00:00:00Z"));

      const at_ = async (iso: string) =>
        (await resolveEffectiveRevision(database(), scenario.organizationId, recipe.id, at(iso)))?.id;

      expect(await at_("2025-12-31T23:59:59Z")).toBeUndefined();
      expect(await at_("2026-03-01T00:00:00Z")).toBe(first.id);
      expect(await at_("2026-05-31T23:59:59.999Z")).toBe(first.id);
      expect(await at_("2026-06-01T00:00:00Z")).toBe(second.id);
    });

    it("supports a future start, leaving the earlier revision in force until then", async () => {
      const recipe = await recipeFixture();
      const first = await draft(recipe.id);
      const second = await draft(recipe.id);
      const now = at("2026-01-01T00:00:00Z");

      await publishRevision(database(), scenario.admin, recipe.id, first.id, { effectiveFrom: null, expectedVersion: first.version }, now);
      await publishRevision(
        database(),
        scenario.admin,
        recipe.id,
        second.id,
        { effectiveFrom: at("2026-09-01T00:00:00Z"), expectedVersion: second.version },
        now,
      );

      const current = await resolveEffectiveRevision(database(), scenario.organizationId, recipe.id, at("2026-05-01T00:00:00Z"));
      const later = await resolveEffectiveRevision(database(), scenario.organizationId, recipe.id, at("2026-09-01T00:00:00Z"));

      expect(current?.id).toBe(first.id);
      expect(later?.id).toBe(second.id);
    });

    it("refuses a past start and a start that is not after earlier revisions", async () => {
      const recipe = await recipeFixture();
      const first = await draft(recipe.id);
      const second = await draft(recipe.id);
      const now = at("2026-06-01T00:00:00Z");

      await expect(
        publishRevision(database(), scenario.admin, recipe.id, first.id, { effectiveFrom: at("2026-05-01T00:00:00Z"), expectedVersion: first.version }, now),
      ).rejects.toMatchObject({ code: "EFFECTIVE_DATE_IN_PAST" });

      await publishRevision(database(), scenario.admin, recipe.id, first.id, { effectiveFrom: null, expectedVersion: first.version }, now);
      await expect(
        publishRevision(database(), scenario.admin, recipe.id, second.id, { effectiveFrom: now, expectedVersion: second.version }, now),
      ).rejects.toMatchObject({ code: "REVISION_ORDER" });
    });

    it("prevents overlapping revisions in the database", async () => {
      const recipe = await recipeFixture();
      const first = await draft(recipe.id);
      const second = await draft(recipe.id);

      await publishRevision(database(), scenario.admin, recipe.id, first.id, { effectiveFrom: null, expectedVersion: first.version }, at("2026-01-01T00:00:00Z"));

      await expect(
        database()
          .update(recipeVersions)
          .set({ status: "PUBLISHED", effectiveFrom: at("2026-03-01T00:00:00Z") })
          .where(eq(recipeVersions.id, second.id)),
      ).rejects.toThrow();
    });

    it("retires a revision, keeping its content and history", async () => {
      const recipe = await recipeFixture();
      const revision = await draft(recipe.id, "3", "keep me");
      const published = await publishRevision(database(), scenario.admin, recipe.id, revision.id, { effectiveFrom: null, expectedVersion: revision.version }, at("2026-01-01T00:00:00Z"));
      const retired = await retireRevision(
        database(),
        scenario.admin,
        recipe.id,
        revision.id,
        { expectedVersion: published.version },
        at("2026-03-01T00:00:00Z"),
      );

      expect(retired).toMatchObject({
        status: "RETIRED",
        preparationNotes: "keep me",
        yieldQuantity: "3.0000",
        effectiveFrom: at("2026-01-01T00:00:00Z"),
        effectiveTo: at("2026-03-01T00:00:00Z"),
      });

      const during = await resolveEffectiveRevision(database(), scenario.organizationId, recipe.id, at("2026-02-01T00:00:00Z"));
      const after = await resolveEffectiveRevision(database(), scenario.organizationId, recipe.id, at("2026-03-01T00:00:00Z"));

      expect(during?.id).toBe(revision.id);
      expect(after).toBeNull();
    });

    it("discards an unpublished draft but never a published revision", async () => {
      const recipe = await recipeFixture();
      const unpublished = await draft(recipe.id);
      const live = await draft(recipe.id);

      await deleteDraftRevision(database(), scenario.admin, recipe.id, unpublished.id);
      await publishRevision(database(), scenario.admin, recipe.id, live.id, { effectiveFrom: null, expectedVersion: live.version }, at("2026-01-01T00:00:00Z"));
      await expect(
        deleteDraftRevision(database(), scenario.admin, recipe.id, live.id),
      ).rejects.toMatchObject({ code: "REVISION_NOT_EDITABLE" });
    });

    it("rejects a stale publish", async () => {
      const recipe = await recipeFixture();
      const revision = await draft(recipe.id);
      await updateDraftRevision(database(), scenario.admin, recipe.id, revision.id, {
        yieldQuantity: "2",
        yieldUnitId: null,
        preparationNotes: null,
        expectedVersion: revision.version,
      });

      await expect(
        publishRevision(database(), scenario.admin, recipe.id, revision.id, { effectiveFrom: null, expectedVersion: revision.version }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
    });

    it("publishes two drafts at once without leaving two in effect", async () => {
      const recipe = await recipeFixture();
      const a = await draft(recipe.id);
      const b = await draft(recipe.id);
      const now = at("2026-01-01T00:00:00Z");
      const results = await Promise.allSettled(
        [a, b].map((revision) =>
          publishRevision(database(), scenario.admin, recipe.id, revision.id, { effectiveFrom: null, expectedVersion: revision.version }, now),
        ),
      );

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    });

    it("keeps the menu item's recipe separate from the item", async () => {
      const item = await itemFixture(database(), scenario.admin);
      const recipe = await recipeFixture(item.id);
      const revision = await draft(recipe.id);

      await publishRevision(database(), scenario.admin, recipe.id, revision.id, { effectiveFrom: null, expectedVersion: revision.version }, at("2026-01-01T00:00:00Z"));

      const found = await resolveEffectiveRevisionForMenuItem(database(), scenario.organizationId, item.id, at("2026-02-01T00:00:00Z"));

      expect(found?.id).toBe(revision.id);
      // The menu item row carries no recipe quantities or yield.
      expect(Object.keys(item).some((key) => /yield|ingredient|quantity|recipe/i.test(key))).toBe(false);
    });
  });

  describe("detail and phase boundaries", () => {
    it("exposes identity, revisions, yield, notes and ingredients, with no cost or stock data", async () => {
      const recipe = await recipeFixture();

      await draft(recipe.id, "64", "Whisk");

      const detail = await getRecipeDetail(database(), scenario.admin, recipe.id);
      const keys = JSON.stringify(detail).toLowerCase();

      expect(detail.revisions[0]).toMatchObject({ yieldQuantity: "64.0000", yieldUnitCode: "EACH", ingredients: [] });
      for (const forbidden of ["onhand", "quantityonhand", "cost", "balance"]) {
        expect(keys).not.toContain(forbidden);
      }
    });

    it("has no settlement or tender tables (Phase 11); tickets are only Phase 10 Kitchen's", async () => {
      const result = await database().execute(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'` as never,
      );
      const names = (result as unknown as { tablename: string }[]).map((row) => row.tablename);

      expect(names.filter((name) => /settlement|tender/.test(name))).toEqual([]);
      expect(names.filter((name) => /ticket|fulfillment/.test(name)).every((name) => name.startsWith("kitchen_"))).toBe(
        true,
      );
    });
  });

  describe("units of measure", () => {
    it("lists the stable vocabulary, never the ambiguous OZ", async () => {
      const units = await listUnits(database(), scenario.admin);
      const codes = units.map((unit) => unit.code);

      expect(codes).toEqual(expect.arrayContaining(["EACH", "OZ_WEIGHT", "LB", "G", "KG", "FL_OZ", "ML", "L"]));
      expect(codes).not.toContain("OZ");
    });

    it("converts approved pairs exactly and rejects the rest", async () => {
      const convert = (quantity: string, fromUnit: string, toUnit: string) =>
        convertUnits(database(), scenario.admin, { quantity, fromUnit, toUnit });

      expect(await convert("1", "LB", "OZ_WEIGHT")).toBe("16.0000");
      expect(await convert("1000", "G", "KG")).toBe("1.0000");
      expect(await convert("1000", "ML", "L")).toBe("1.0000");
      await expect(convert("1", "LB", "FL_OZ")).rejects.toMatchObject({ code: "INCOMPATIBLE_UNITS" });
      await expect(convert("1", "FL_OZ", "ML")).rejects.toMatchObject({ code: "NO_APPROVED_CONVERSION" });
    });

    it("refuses an ambiguous unit code in the database", async () => {
      await expect(
        database().execute(
          `INSERT INTO units_of_measure (code, name, measurement_type) VALUES ('OZ', 'Ounce', 'WEIGHT')` as never,
        ),
      ).rejects.toThrow();
    });

    it("refuses a conversion across measurement types in the database", async () => {
      const lb = await unitId(database(), "LB");
      const ml = await unitId(database(), "ML");

      await expect(
        database().execute(
          `INSERT INTO unit_conversions (from_unit_id, to_unit_id, measurement_type, factor) VALUES ('${lb}', '${ml}', 'WEIGHT', 1)` as never,
        ),
      ).rejects.toThrow();
    });
  });

  describe("authorization", () => {
    it("requires recipes.edit to change recipes and recipes.view to read them", async () => {
      await expect(
        createRecipe(database(), scenario.viewer, { code: uniqueCode("RCP"), name: "x", description: null, menuItemId: null }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(listRecipes(database(), scenario.viewer)).rejects.toBeInstanceOf(AuthorizationError);

      const recipe = await recipeFixture();

      await expect(getRecipeDetail(database(), scenario.outsider, recipe.id)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        createDraftRevision(database(), scenario.viewer, recipe.id, { yieldQuantity: "1", yieldUnitId: null, preparationNotes: null }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("treats another organization's recipe as absent", async () => {
      const recipe = await recipeFixture();

      await expect(getRecipeDetail(database(), scenario.other, recipe.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        createDraftRevision(database(), scenario.other, recipe.id, { yieldQuantity: "1", yieldUnitId: null, preparationNotes: null }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
