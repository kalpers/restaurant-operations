import { expect, test, type Page } from "@playwright/test";

import {
  createKitchenMenu,
  createKitchenPermissionAccount,
  createKitchenRoleAccount,
  firstTicketItem,
  mediumSelection,
  orderStatus,
  removeKitchenE2eData,
  sendKitchenOrder,
  ticketItemStatuses,
  type KitchenAccount,
} from "../helpers/e2e-kitchen";

async function signIn(page: Page, account: KitchenAccount) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

const card = (page: Page, orderNumber: number) =>
  page.locator(`[data-testid="active-queue"] [data-testid="ticket-card"][data-order-number="${orderNumber}"]`);

test.afterAll(async () => {
  await removeKitchenE2eData();
});

test.describe("kitchen and bar", () => {
  test("food goes to the kitchen and drinks to the bar, each runs Start, Ready, Bump; the server is told", async ({
    browser,
  }) => {
    const manager = await createKitchenRoleAccount("MANAGER");
    const server = await createKitchenRoleAccount("SERVER");
    const cook = await createKitchenRoleAccount("COOK");
    const bartender = await createKitchenRoleAccount("BARTENDER");
    const menu = await createKitchenMenu(manager);
    const cookPage = await (await browser.newContext()).newPage();

    await signIn(cookPage, cook);
    await cookPage.goto("/kitchen");
    await expect(cookPage.getByTestId("connection-status")).toHaveText("Live", { timeout: 15_000 });

    // The order is sent after the kitchen screen is open: it must arrive without a reload.
    const sent = await sendKitchenOrder(server, manager, [
      { menuItemId: menu.burger.id, selections: await mediumSelection(menu.burger.id) },
      { menuItemId: menu.soda.id },
    ]);
    const kitchenCard = card(cookPage, sent.orderNumber);

    await expect(kitchenCard).toBeVisible({ timeout: 10_000 });
    await expect(kitchenCard).toContainText(menu.burger.name);
    await expect(kitchenCard).toContainText("Medium");
    await expect(kitchenCard).toContainText(sent.tableNumber!);
    // Bar-routed work never reaches the kitchen queue.
    await expect(kitchenCard).not.toContainText(menu.soda.name);

    await kitchenCard.getByRole("button", { name: "Start" }).click();
    await expect(kitchenCard.getByTestId("item-status")).toHaveText("PREPARING");
    await expect(kitchenCard.getByRole("button", { name: "Ready" })).toBeVisible();
    await kitchenCard.getByRole("button", { name: "Ready" }).click();
    await expect(kitchenCard.getByTestId("ticket-status")).toHaveText("READY");
    await kitchenCard.getByRole("button", { name: "Bump" }).click();
    await expect(kitchenCard).toHaveCount(0);
    await expect(cookPage.getByTestId("recently-completed")).toContainText(`#${sent.orderNumber}`);

    // The bartender sees the same order's drink, with the same order context.
    const barPage = await (await browser.newContext()).newPage();

    await signIn(barPage, bartender);
    await barPage.goto("/bar");

    const barCard = card(barPage, sent.orderNumber);

    await expect(barCard).toContainText(menu.soda.name);
    await expect(barCard).toContainText(sent.tableNumber!);
    await expect(barCard).not.toContainText(menu.burger.name);
    await barCard.getByRole("button", { name: "Start" }).click();
    await expect(barCard.getByRole("button", { name: "Ready" })).toBeVisible();
    await barCard.getByRole("button", { name: "Ready" }).click();
    await expect(barCard.getByRole("button", { name: "Bump" })).toBeVisible();
    await barCard.getByRole("button", { name: "Bump" }).click();
    await expect(barCard).toHaveCount(0);

    // The server who sent it gets the ready notifications, and the order stays OPEN.
    const serverPage = await (await browser.newContext()).newPage();

    await signIn(serverPage, server);
    await expect(serverPage.getByTestId("notification-count")).toHaveText("2", { timeout: 10_000 });
    await serverPage.getByTestId("notification-bell").click();
    await expect(serverPage.getByText(`Food ready: order #${sent.orderNumber}`)).toBeVisible();
    await expect(serverPage.getByText(`Drinks ready: order #${sent.orderNumber}`)).toBeVisible();
    expect(await orderStatus(sent.orderId)).toMatchObject({ status: "OPEN" });
    expect((await ticketItemStatuses(sent.orderId)).sort()).toEqual(["COMPLETED", "COMPLETED"]);
  });

  test("a manager's not-prepared void cancels the kitchen work and the item shows as voided", async ({ page }) => {
    const manager = await createKitchenRoleAccount("MANAGER");
    const server = await createKitchenRoleAccount("SERVER");
    const menu = await createKitchenMenu(manager);
    const sent = await sendKitchenOrder(server, manager, [
      { menuItemId: menu.burger.id, selections: await mediumSelection(menu.burger.id) },
    ]);

    await signIn(page, manager);
    await page.goto("/kitchen");
    await expect(card(page, sent.orderNumber)).toBeVisible();

    await page.goto(`/orders/${sent.orderId}`);

    const sentBurger = page.getByRole("listitem", { name: `Sent ${menu.burger.name}` });

    await expect(sentBurger.getByTestId("fulfillment-status")).toContainText("NEW");
    await sentBurger.getByText("Void item").click();

    const voidForm = page.getByRole("form", { name: `Void ${menu.burger.name}` });

    await voidForm.getByLabel("Reason").fill("Wrong table");
    await voidForm.getByLabel("Not prepared (return stock)").check();
    await voidForm.getByLabel("I confirm this void").check();
    await voidForm.getByRole("button", { name: `Void ${menu.burger.name}` }).click();

    const voided = page.getByRole("listitem", { name: `Voided ${menu.burger.name}` });

    await expect(voided).toContainText("not prepared");
    await expect(voided.getByTestId("fulfillment-status")).toContainText("CANCELLED");

    await page.goto("/kitchen");
    await expect(card(page, sent.orderNumber)).toHaveCount(0);
    expect(await ticketItemStatuses(sent.orderId)).toEqual(["CANCELLED"]);
  });

  test("takeout runs through the same station with no table", async ({ page }) => {
    const manager = await createKitchenRoleAccount("MANAGER");
    const server = await createKitchenRoleAccount("SERVER");
    const cook = await createKitchenRoleAccount("COOK");
    const menu = await createKitchenMenu(manager);
    const sent = await sendKitchenOrder(
      server,
      manager,
      [{ menuItemId: menu.burger.id, selections: await mediumSelection(menu.burger.id) }],
      "TAKEOUT",
    );

    await signIn(page, cook);
    await page.goto("/kitchen?orderType=TAKEOUT");

    const takeout = card(page, sent.orderNumber);

    await expect(takeout).toContainText("Takeout");
    await expect(takeout).toContainText("Pickup Pat");
    await takeout.getByRole("button", { name: "Start" }).click();
    await expect(takeout.getByRole("button", { name: "Ready" })).toBeVisible();
    await takeout.getByRole("button", { name: "Ready" }).click();
    await expect(takeout.getByRole("button", { name: "Bump" })).toBeVisible();
    await takeout.getByRole("button", { name: "Bump" }).click();
    await expect(takeout).toHaveCount(0);
    expect(await orderStatus(sent.orderId)).toEqual({ status: "OPEN", tableSessionId: null });
  });

  test("a view-only kitchen user sees the queue without actions, and the API refuses them", async ({ page }) => {
    const manager = await createKitchenRoleAccount("MANAGER");
    const server = await createKitchenRoleAccount("SERVER");
    const viewer = await createKitchenPermissionAccount(["kitchen.view"]);
    const menu = await createKitchenMenu(manager);
    const sent = await sendKitchenOrder(server, manager, [
      { menuItemId: menu.burger.id, selections: await mediumSelection(menu.burger.id) },
    ]);

    await signIn(page, viewer);
    await page.goto("/kitchen");

    const viewOnly = card(page, sent.orderNumber);

    await expect(viewOnly).toContainText(menu.burger.name);
    await expect(viewOnly.getByRole("button")).toHaveCount(0);

    const item = await firstTicketItem(sent.orderId);
    const refused = await page.request.post(`/api/kitchen/items/${item.id}/start`, {
      data: { expectedVersion: item.version },
    });

    expect(refused.status()).toBe(403);
    expect((await refused.json()).error.code).toBe("PERMISSION_DENIED");

    // The bar queue needs bar.view.
    await page.goto("/bar");
    await expect(page).toHaveURL(/\/access-denied$/);

    const signedOut = await page.context().browser()!.newContext();
    const anonymous = await signedOut.request.post(
      new URL(`/api/kitchen/items/${item.id}/start`, page.url()).toString(),
      { data: { expectedVersion: item.version } },
    );

    expect(anonymous.status()).toBe(401);
    expect(await ticketItemStatuses(sent.orderId)).toEqual(["NEW"]);
  });
});
