import { expect, test, type Page } from "@playwright/test";

import {
  createOrderMenu,
  createPermissionAccount,
  createRoleAccount,
  ledgerTypesFor,
  onHand,
  removeOrdersE2eData,
  seatE2eParty,
  sessionsCreatedBy,
  takeoutWithDraft,
  type OrdersAccount,
} from "../helpers/e2e-orders";

async function signIn(page: Page, account: OrdersAccount) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/** Picks an item from the menu with the given modifiers and adds it as a draft. */
async function addItem(page: Page, categoryName: string, itemName: string, modifiers: string[] = []) {
  const menu = page.getByRole("region", { name: "Menu" });

  await menu.getByRole("tab", { name: categoryName }).click();
  await menu.getByRole("button", { name: new RegExp(itemName) }).click();

  const picker = page.getByRole("form", { name: `Add ${itemName}` });

  for (const modifier of modifiers) {
    await picker.getByLabel(modifier).check();
  }

  await picker.getByRole("button", { name: "Add to order" }).click();
  await expect(page.getByRole("listitem", { name: `Unsent ${itemName}` })).toBeVisible();
}

test.afterAll(async () => {
  await removeOrdersE2eData();
});

test.describe("orders", () => {
  test("a seated party's dine-in order: modifiers, exact price, send, then a second round", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const server = await createRoleAccount("SERVER");
    const menu = await createOrderMenu(manager);
    const { tableNumber } = await seatE2eParty(manager);

    await signIn(page, server);
    await page.goto("/restaurant/floor");
    await page.getByRole("listitem", { name: `Table ${tableNumber}` }).getByRole("link", { name: "Orders" }).click();
    await page.getByRole("button", { name: "New dine-in order" }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);

    // The required temperature is enforced by the server.
    const menuRegion = page.getByRole("region", { name: "Menu" });

    await menuRegion.getByRole("tab", { name: menu.categoryName }).click();
    await menuRegion.getByRole("button", { name: new RegExp(menu.burger.name) }).click();
    await page.getByRole("form", { name: `Add ${menu.burger.name}` }).getByRole("button", { name: "Add to order" }).click();
    await expect(page.getByRole("form", { name: `Add ${menu.burger.name}` }).getByRole("alert")).toContainText(
      "Choose at least 1 from Temperature",
    );
    await page.getByRole("form", { name: `Add ${menu.burger.name}` }).getByRole("button", { name: "Cancel" }).click();

    await addItem(page, menu.categoryName, menu.burger.name, ["Medium", "Extra Pickles"]);
    await expect(page.getByRole("listitem", { name: `Unsent ${menu.burger.name}` })).toContainText("$12.75");
    // A draft is a preview: nothing counts toward the total and nothing is consumed.
    await expect(page.getByLabel("Order total")).toHaveText("$0.00");
    expect(await onHand(menu.pickles.id)).toBe("50.0000");

    await page.getByRole("button", { name: "Send 1 item" }).click();

    const sentBurger = page.getByRole("listitem", { name: `Sent ${menu.burger.name}` });

    await expect(sentBurger).toContainText("Sent in round 1");
    await expect(sentBurger).toContainText("Medium, Extra Pickles (+$0.75)");
    await expect(page.getByLabel("Order total")).toHaveText("$12.75");
    expect(await onHand(menu.pickles.id)).toBe("45.0000");
    expect(await onHand(menu.beef.id)).toBe("49.0000");

    // Second round: only the new item is sent; the first is unchanged.
    await addItem(page, menu.categoryName, menu.soda.name);
    await page.getByRole("button", { name: "Send 1 item" }).click();
    await expect(page.getByRole("listitem", { name: `Sent ${menu.soda.name}` })).toContainText("Sent in round 2");
    await expect(sentBurger).toContainText("Sent in round 1");
    await expect(page.getByLabel("Order total")).toHaveText("$15.25");
    expect(await ledgerTypesFor(menu.beef.id)).toEqual(["RECEIVE", "CONSUME"]);

    // A server can't void: no void control is shown.
    await expect(sentBurger.getByText("Void item")).toHaveCount(0);
  });

  test("a takeout order needs no table, and a manager voids a sent item that stays visible", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const menu = await createOrderMenu(manager);

    await signIn(page, manager);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Orders", exact: true }).click();

    const takeout = page.getByRole("region", { name: "Takeout" });

    await takeout.getByLabel("Pickup name (optional)").fill("Robin");
    await takeout.getByRole("button", { name: "New takeout order" }).click();
    await expect(page.getByRole("heading", { name: /Order #\d+/ })).toBeVisible();
    await expect(page.getByText(/Takeout · Robin/)).toBeVisible();

    await addItem(page, menu.categoryName, menu.burger.name, ["Medium"]);
    await addItem(page, menu.categoryName, menu.soda.name);
    await page.getByRole("button", { name: "Send 2 items" }).click();
    await expect(page.getByLabel("Order total")).toHaveText("$14.50");
    expect(await sessionsCreatedBy(manager.id)).toBe(0);
    expect(await onHand(menu.beef.id)).toBe("49.0000");

    const sentBurger = page.getByRole("listitem", { name: `Sent ${menu.burger.name}` });

    await sentBurger.getByText("Void item").click();

    const voidForm = page.getByRole("form", { name: `Void ${menu.burger.name}` });

    await voidForm.getByLabel("Reason").fill("Guest changed their mind");
    await voidForm.getByLabel("Not prepared (return stock)").check();
    await voidForm.getByLabel("I confirm this void").check();
    await voidForm.getByRole("button", { name: `Void ${menu.burger.name}` }).click();

    const voided = page.getByRole("listitem", { name: `Voided ${menu.burger.name}` });

    await expect(voided).toContainText("Voided · not prepared · Guest changed their mind");
    await expect(page.getByLabel("Order total")).toHaveText("$2.50");
    expect(await onHand(menu.beef.id)).toBe("50.0000");
    expect(await ledgerTypesFor(menu.beef.id)).toEqual(["RECEIVE", "CONSUME", "SALE_REVERSAL"]);
  });

  test("a view-only user can read an order but not send it, and the API refuses", async ({ page, playwright, baseURL }) => {
    const manager = await createRoleAccount("MANAGER");
    const menu = await createOrderMenu(manager);
    const { orderId, version } = await takeoutWithDraft(manager, menu.soda.id);
    const viewer = await createPermissionAccount(["orders.view", "menu.view"]);

    await signIn(page, viewer);
    await page.goto(`/orders/${orderId}`);
    await expect(page.getByRole("listitem", { name: `Unsent ${menu.soda.name}` })).toBeVisible();
    await expect(page.getByRole("button", { name: /Send/ })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Menu" })).toHaveCount(0);

    const forbidden = await page.request.post(`/api/orders/${orderId}/send`, {
      data: { expectedVersion: version },
      headers: { "Idempotency-Key": "e2e-view-only-key" },
    });

    expect(forbidden.status()).toBe(403);
    expect((await forbidden.json()).error.code).toBe("PERMISSION_DENIED");

    const anonymous = await playwright.request.newContext({ baseURL });
    const signedOut = await anonymous.post(`/api/orders/${orderId}/send`, {
      data: { expectedVersion: version },
      headers: { "Idempotency-Key": "e2e-signed-out-key" },
    });

    expect(signedOut.status()).toBe(401);
    expect((await anonymous.get(`/api/orders/${orderId}`)).status()).toBe(401);
    await anonymous.dispose();
    expect(await onHand(menu.beef.id)).toBe("50.0000");
  });
});
