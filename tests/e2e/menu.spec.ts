import { expect, test, type Page } from "@playwright/test";

import { createMenuE2e, type MenuAccount } from "../helpers/e2e-menu";

const { createGroupFixture, createPermissionAccount, createRoleAccount, removeMenuE2eData, uniqueCode } = createMenuE2e("MENU");

async function signIn(page: Page, account: MenuAccount) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

const mainNavigation = (page: Page) => page.getByRole("navigation", { name: "Main" });

test.afterAll(async () => {
  await removeMenuE2eData();
});

test.describe("menu administration", () => {
  test("a manager configures an item and the operational menu reflects it", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const categoryCode = uniqueCode("_CAT");
    const categoryName = `E2E Burgers ${categoryCode.slice(-6)}`;
    const itemCode = uniqueCode("_ITM");
    const itemName = `E2E Cheeseburger ${itemCode.slice(-6)}`;
    const group = await createGroupFixture(manager, {
      name: `E2E Temperature ${itemCode.slice(-6)}`,
      modifiers: [
        { name: "Medium", priceAdjustment: "0.00" },
        { name: "Extra bacon", priceAdjustment: "2.00" },
      ],
    });

    await signIn(page, manager);
    await mainNavigation(page).getByRole("link", { name: "Manage menu", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Manage menu", exact: true })).toBeVisible();

    // A category.
    const categories = page.getByRole("region", { name: "Categories" });

    await categories.getByLabel("Code (capitals, digits, underscores)").fill(categoryCode);
    await categories.getByLabel("Name", { exact: true }).first().fill(categoryName);
    await categories.getByRole("button", { name: "Add category" }).click();
    await expect(page.getByRole("listitem", { name: `Category ${categoryCode}` })).toBeVisible();

    // An item.
    const items = page.getByRole("region", { name: "Menu items" });

    await items.getByLabel("Code (capitals, digits, underscores)").fill(itemCode);
    await items.getByLabel("Name", { exact: true }).fill(itemName);
    await items.getByRole("button", { name: "Add item" }).click();
    await page.getByRole("link", { name: `Edit ${itemName}` }).click();
    await expect(page.getByRole("heading", { name: itemName })).toBeVisible();

    // Before a price exists the item can't be sold.
    await expect(page.getByText("No price yet")).toBeVisible();

    // A price.
    const pricing = page.getByRole("region", { name: "Pricing" });

    await pricing.getByLabel("New price").fill("14.99");
    await pricing.getByRole("button", { name: "Set new price" }).click();
    await expect(pricing.getByText("$14.99 (current)")).toBeVisible();

    // A placement on the Main Menu.
    const placements = page.getByRole("region", { name: "Placements" });

    await placements.locator('select[name="menuId"]').selectOption({ label: "Main Menu" });
    await placements.locator('select[name="menuCategoryId"]').selectOption({ label: categoryName });
    await placements.getByRole("button", { name: "Add to menu" }).click();
    await expect(placements.getByText(`Main Menu · ${categoryName}`)).toBeVisible();

    // A required modifier group.
    const groups = page.getByRole("region", { name: "Modifier groups" });

    await groups.locator('select[name="modifierGroupId"]').selectOption({ label: group.name });
    await groups.getByRole("button", { name: "Attach group" }).click();

    const attached = groups.getByRole("listitem", { name: `Modifier group ${group.name}` });

    await expect(attached).toContainText("Choose 1");
    await expect(attached).toContainText("required");
    await expect(attached).toContainText("Extra bacon ($2.00)");

    // The operational menu now shows the item, its price and its modifier choices.
    await mainNavigation(page).getByRole("link", { name: "Menu", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Menu", exact: true })).toBeVisible();

    const listed = page.getByRole("listitem", { name: `Menu item ${itemName}` });

    await expect(listed).toContainText("$14.99");
    await expect(listed).toContainText(group.name);
    await expect(listed).toContainText("Extra bacon (+$2.00)");
  });

  test("stops offering an item that is marked unavailable", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const itemCode = uniqueCode("_ITM");
    const itemName = `E2E Special ${itemCode.slice(-6)}`;
    const categoryCode = uniqueCode("_CAT");
    const categoryName = `E2E Specials ${categoryCode.slice(-6)}`;

    await signIn(page, manager);
    await page.goto("/menu/manage");

    const categories = page.getByRole("region", { name: "Categories" });

    await categories.getByLabel("Code (capitals, digits, underscores)").fill(categoryCode);
    await categories.getByLabel("Name", { exact: true }).first().fill(categoryName);
    await categories.getByRole("button", { name: "Add category" }).click();
    await expect(page.getByRole("listitem", { name: `Category ${categoryCode}` })).toBeVisible();

    const items = page.getByRole("region", { name: "Menu items" });

    await items.getByLabel("Code (capitals, digits, underscores)").fill(itemCode);
    await items.getByLabel("Name", { exact: true }).fill(itemName);
    await items.getByRole("button", { name: "Add item" }).click();
    await page.getByRole("link", { name: `Edit ${itemName}` }).click();

    await page.getByRole("region", { name: "Pricing" }).getByLabel("New price").fill("9.50");
    await page.getByRole("button", { name: "Set new price" }).click();

    const placements = page.getByRole("region", { name: "Placements" });

    await placements.locator('select[name="menuId"]').selectOption({ label: "Main Menu" });
    await placements.locator('select[name="menuCategoryId"]').selectOption({ label: categoryName });
    await placements.getByRole("button", { name: "Add to menu" }).click();
    await expect(placements.getByText(`Main Menu · ${categoryName}`)).toBeVisible();

    await page.goto("/menu");
    await expect(page.getByRole("listitem", { name: `Menu item ${itemName}` })).toBeVisible();

    // 86 it: still in the catalog, but not for sale.
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Manage menu" }).click();
    await page.getByRole("link", { name: `Edit ${itemName}` }).click();

    const details = page.getByRole("region", { name: "Details" });

    await details.getByLabel("Available (can be sold now)").uncheck();
    await details.getByRole("button", { name: "Save item" }).click();
    await expect(details.getByText("Saved.")).toBeVisible();

    await page.goto("/menu");
    await expect(page.getByRole("listitem", { name: `Menu item ${itemName}` })).toHaveCount(0);
  });

  test("a Server can read the menu but cannot edit it, by page or by API", async ({ page }) => {
    const server = await createRoleAccount("SERVER");

    await signIn(page, server);
    await expect(mainNavigation(page).getByRole("link", { name: "Menu", exact: true })).toBeVisible();
    await expect(mainNavigation(page).getByRole("link", { name: "Manage menu" })).toHaveCount(0);

    for (const path of ["/menu/manage", "/menu/modifiers", "/menu/stations", "/recipes"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/access-denied$/);
    }

    const category = await page.request.post("/api/menu/categories", {
      data: { code: "E2EM_DENIED", name: "Denied", displayOrder: 0 },
    });
    const price = await page.request.post(
      "/api/menu/items/00000000-0000-4000-8000-000000000000/prices",
      { data: { price: "1.00" } },
    );
    const history = await page.request.get(
      "/api/menu/items/00000000-0000-4000-8000-000000000000/prices",
    );
    const recipe = await page.request.post("/api/recipes", {
      data: { code: "E2EM_DENIED", name: "Denied" },
    });

    expect(category.status()).toBe(403);
    expect(price.status()).toBe(403);
    expect(history.status()).toBe(403);
    expect(recipe.status()).toBe(403);
    expect((await page.request.get("/api/menu/operational")).status()).toBe(200);
  });

  test("a signed-out request is refused", async ({ request }) => {
    expect((await request.get("/api/menu/operational")).status()).toBe(401);
    expect(
      (await request.post("/api/menu/categories", { data: { code: "E2EM_X", name: "X" } })).status(),
    ).toBe(401);
  });

  test("an editor without pricing permission can edit items but sees no pricing", async ({ page }) => {
    const editor = await createPermissionAccount(["menu.view", "menu.edit"]);
    const itemCode = uniqueCode("_ITM");
    const itemName = `E2E Plain ${itemCode.slice(-6)}`;

    await signIn(page, editor);
    await page.goto("/menu/manage");

    const items = page.getByRole("region", { name: "Menu items" });

    await items.getByLabel("Code (capitals, digits, underscores)").fill(itemCode);
    await items.getByLabel("Name", { exact: true }).fill(itemName);
    await items.getByRole("button", { name: "Add item" }).click();
    await page.getByRole("link", { name: `Edit ${itemName}` }).click();

    await expect(page.getByRole("heading", { name: itemName })).toBeVisible();
    await expect(page.getByRole("region", { name: "Pricing" })).toHaveCount(0);

    const direct = await page.request.post(
      `/api/menu/items/${page.url().split("/").pop()}/prices`,
      { data: { price: "1.00" } },
    );

    expect(direct.status()).toBe(403);
  });
});

test.describe("modifier validation", () => {
  test("rejects an impossible minimum and maximum, and shows a modifier price", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const groupCode = uniqueCode("_G");
    const modifierCode = uniqueCode("_M");
    const modifierName = `E2E Add bacon ${modifierCode.slice(-6)}`;
    const groupName = `E2E Add-ons ${groupCode.slice(-6)}`;

    await signIn(page, manager);
    await mainNavigation(page).getByRole("link", { name: "Modifiers", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Modifiers", exact: true, level: 1 })).toBeVisible();

    const groups = page.getByRole("region", { name: "Modifier groups" });
    const add = groups.locator("div", { hasText: "Add a group" }).first();

    await add.getByLabel("Code (capitals, digits, underscores)").fill(groupCode);
    await add.getByLabel("Name", { exact: true }).fill(groupName);
    await add.locator('select[name="selectionType"]').selectOption("REQUIRED_MULTIPLE");
    await add.getByLabel("Minimum selections").fill("3");
    await add.getByLabel("Maximum selections (blank for no limit)").fill("2");
    await add.getByRole("button", { name: "Add group" }).click();

    await expect(add.getByRole("alert")).toContainText("below the minimum");
    await expect(page.getByRole("listitem", { name: `Modifier group ${groupCode}` })).toHaveCount(0);

    await add.getByLabel("Maximum selections (blank for no limit)").fill("4");
    await add.getByRole("button", { name: "Add group" }).click();
    await expect(page.getByRole("listitem", { name: `Modifier group ${groupCode}` })).toContainText(
      "Choose 3 to 4",
    );

    const modifiers = page.getByRole("region", { name: "Modifiers", exact: true });
    const addModifier = modifiers.locator("div", { hasText: "Add a modifier" }).first();

    await addModifier.getByLabel("Code (capitals, digits, underscores)").fill(modifierCode);
    await addModifier.getByLabel("Name", { exact: true }).fill(modifierName);
    await addModifier.getByLabel("Price adjustment").fill("1.50");
    await addModifier.getByRole("button", { name: "Add modifier" }).click();
    await expect(
      page.getByRole("listitem", { name: `Modifier ${modifierCode}` }),
    ).toContainText("$1.50");

    // Extra precision is refused by the server, not trimmed.
    await addModifier.getByLabel("Code (capitals, digits, underscores)").fill(uniqueCode("_M"));
    await addModifier.getByLabel("Name", { exact: true }).fill("E2E Too precise");
    await addModifier.getByLabel("Price adjustment").fill("1.505");
    await addModifier.getByRole("button", { name: "Add modifier" }).click();
    await expect(addModifier.getByRole("alert")).toContainText("two decimal places");
  });
});

test.describe("prep stations", () => {
  test("a manager adds a station and routes an item to it", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const stationCode = uniqueCode("_ST");
    const itemCode = uniqueCode("_ITM");
    const itemName = `E2E Wings ${itemCode.slice(-6)}`;

    await signIn(page, manager);
    await mainNavigation(page).getByRole("link", { name: "Prep stations", exact: true }).click();
    await page.getByLabel("Code (capitals, digits, underscores)").fill(stationCode);
    await page.getByLabel("Name", { exact: true }).first().fill(`E2E Fryer ${stationCode.slice(-6)}`);
    await page.getByRole("button", { name: "Add station" }).click();
    await expect(page.getByRole("listitem", { name: `Station ${stationCode}` })).toBeVisible();

    await page.goto("/menu/manage");

    const items = page.getByRole("region", { name: "Menu items" });

    await items.getByLabel("Code (capitals, digits, underscores)").fill(itemCode);
    await items.getByLabel("Name", { exact: true }).fill(itemName);
    await items.getByRole("button", { name: "Add item" }).click();
    await page.getByRole("link", { name: `Edit ${itemName}` }).click();

    const routing = page.getByRole("region", { name: "Preparation routing" });

    await routing.getByLabel(`E2E Fryer ${stationCode.slice(-6)}`).check();
    await routing.getByRole("button", { name: "Save routing" }).click();
    await expect(routing.getByText("Saved.")).toBeVisible();
    await page.reload();
    await expect(
      page
        .getByRole("region", { name: "Preparation routing" })
        .getByLabel(`E2E Fryer ${stationCode.slice(-6)}`),
    ).toBeChecked();
  });
});
