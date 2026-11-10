import { expect, test, type Page } from "@playwright/test";

import { confirmDialog } from "../helpers/e2e-ui";

import { createMenuE2e, type MenuAccount } from "../helpers/e2e-menu";

const { createPermissionAccount, createRoleAccount, removeMenuE2eData, uniqueCode } = createMenuE2e("RECIPES");

async function signIn(page: Page, account: MenuAccount) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test.afterAll(async () => {
  await removeMenuE2eData();
});

test.describe("recipe administration", () => {
  test("creates a recipe, drafts a revision, publishes it, then replaces it", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const code = uniqueCode("_RCP");
    const name = `E2E Sauce ${code.slice(-6)}`;

    await signIn(page, manager);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Recipes", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Recipes", exact: true })).toBeVisible();

    const add = page.getByRole("region", { name: "Add a recipe" });

    await add.getByLabel("Code (capitals, digits, underscores)").fill(code);
    await add.getByLabel("Name", { exact: true }).fill(name);
    await add.getByRole("button", { name: "Add recipe" }).click();
    await page.getByRole("link", { name: `Open ${name}` }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await expect(page.getByText("Saving a recipe never changes stock")).toBeVisible();

    // A draft revision with yield, unit and notes.
    const draft = page.getByRole("region", { name: "New revision" });

    await draft.getByLabel("Yield quantity").fill("64");
    await draft.getByLabel("Yield unit").selectOption({ label: "Fluid ounce (FL_OZ)" });
    await draft.getByLabel("Preparation notes").fill("Simmer 20 minutes, then cool.");
    await draft.getByRole("button", { name: "Create draft revision" }).click();

    const first = page.getByRole("listitem", { name: "Revision 1" });

    await expect(first).toContainText("Revision 1 · Draft");
    await expect(first).toContainText("Yield 64.0000 FL_OZ");
    await expect(first).toContainText("Simmer 20 minutes, then cool.");

    // Publish it, effective now.
    await first.getByRole("button", { name: "Publish revision" }).click();
    await expect(first).toContainText("Revision 1 · Published · In effect now");
    await expect(first).toContainText("until open-ended");

    // A second revision replaces it.
    await draft.getByLabel("Yield quantity").fill("128");
    await draft.getByLabel("Preparation notes").fill("Double batch.");
    await draft.getByRole("button", { name: "Create draft revision" }).click();

    const second = page.getByRole("listitem", { name: "Revision 2" });

    await expect(second).toContainText("Revision 2 · Draft");
    await second.getByRole("button", { name: "Publish revision" }).click();
    await expect(second).toContainText("Revision 2 · Published · In effect now");
    await expect(first).not.toContainText("In effect now");
    await expect(first).not.toContainText("until open-ended");
    // The first revision's content is kept as history.
    await expect(first).toContainText("Yield 64.0000 FL_OZ");
    await expect(first).toContainText("Simmer 20 minutes, then cool.");

    // Retire the current revision.
    await second.getByRole("button", { name: "Retire revision" }).click();
    await confirmDialog(page, "Retire revision");
    await expect(second).toContainText("Revision 2 · Retired");
  });

  test("a published revision cannot be edited by API", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const code = uniqueCode("_RCP");
    const name = `E2E Dressing ${code.slice(-6)}`;

    await signIn(page, manager);
    await page.goto("/recipes");

    const add = page.getByRole("region", { name: "Add a recipe" });

    await add.getByLabel("Code (capitals, digits, underscores)").fill(code);
    await add.getByLabel("Name", { exact: true }).fill(name);
    await add.getByRole("button", { name: "Add recipe" }).click();
    await page.getByRole("link", { name: `Open ${name}` }).click();

    const draft = page.getByRole("region", { name: "New revision" });

    await draft.getByLabel("Yield quantity").fill("1");
    await draft.getByRole("button", { name: "Create draft revision" }).click();

    const first = page.getByRole("listitem", { name: "Revision 1" });

    await first.getByRole("button", { name: "Publish revision" }).click();
    await expect(first).toContainText("Published");

    const recipeId = page.url().split("/").pop();
    const detail = await (await page.request.get(`/api/recipes/${recipeId}`)).json();
    const revision = detail.revisions[0];
    const edit = await page.request.patch(`/api/recipes/${recipeId}/revisions/${revision.id}`, {
      data: { yieldQuantity: "9", yieldUnitId: null, preparationNotes: "x", expectedVersion: revision.version },
    });

    expect(edit.status()).toBe(422);
    expect((await edit.json()).error.code).toBe("REVISION_NOT_EDITABLE");
  });

  test("a recipe viewer sees recipes but cannot edit them, by page or API", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const viewer = await createPermissionAccount(["recipes.view"]);
    const code = uniqueCode("_RCP");
    const name = `E2E Stock ${code.slice(-6)}`;

    // The manager creates the recipe; the viewer then opens it.
    await signIn(page, manager);
    await page.goto("/recipes");

    const add = page.getByRole("region", { name: "Add a recipe" });

    await add.getByLabel("Code (capitals, digits, underscores)").fill(code);
    await add.getByLabel("Name", { exact: true }).fill(name);
    await add.getByRole("button", { name: "Add recipe" }).click();
    await expect(page.getByRole("link", { name: `Open ${name}` })).toBeVisible();
    await page.context().clearCookies();

    await signIn(page, viewer);
    await page.goto("/recipes");
    await expect(page.getByRole("link", { name: `Open ${name}` })).toBeVisible();
    await expect(page.getByRole("region", { name: "Add a recipe" })).toHaveCount(0);
    await page.getByRole("link", { name: `Open ${name}` }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await expect(page.getByRole("region", { name: "New revision" })).toHaveCount(0);

    const recipeId = page.url().split("/").pop();
    const created = await page.request.post("/api/recipes", {
      data: { code: uniqueCode("_RCP"), name: "Denied" },
    });
    const draft = await page.request.post(`/api/recipes/${recipeId}/revisions`, {
      data: { yieldQuantity: "1" },
    });

    expect(created.status()).toBe(403);
    expect(draft.status()).toBe(403);
  });

  test("a Server has no access to recipes", async ({ page }) => {
    const server = await createRoleAccount("SERVER");

    await signIn(page, server);
    await page.goto("/recipes");
    await expect(page).toHaveURL(/\/access-denied$/);
    expect((await page.request.get("/api/recipes")).status()).toBe(403);
  });
});
