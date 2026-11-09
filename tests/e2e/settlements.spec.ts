import { expect, test, type Page } from "@playwright/test";

import {
  compOrder,
  createOrderMenu,
  createPermissionAccount,
  createRoleAccount,
  ledgerTypesFor,
  orderStatus,
  removeOrdersE2eData,
  seatE2eParty,
  sentOrderFor,
  tenderTextFor,
  type OrdersAccount,
} from "../helpers/e2e-orders";

// Settlement is record only: these flows record what happened at a register or an
// external card terminal; nothing here processes a payment.

async function signIn(page: Page, account: OrdersAccount) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function openSettlementScreen(page: Page, orderId: string, amount: string) {
  await page.goto(`/orders/${orderId}`);
  await page.getByRole("link", { name: "Settle check" }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${orderId}/settlement$`));
  await page.getByRole("button", { name: `Open settlement for ${amount}` }).click();
  await expect(page.getByRole("region", { name: "Open settlement" })).toBeVisible();
}

function tenderForm(page: Page) {
  return page.getByRole("form", { name: "Record tender" });
}

async function expectClosed(page: Page, orderId: string) {
  await expect(page.getByTestId("order-status")).toHaveText("CLOSED");
  await expect(page.getByRole("region", { name: "Completed settlement" })).toBeVisible();
  expect(await orderStatus(orderId)).toBe("CLOSED");
}

test.afterAll(async () => {
  await removeOrdersE2eData();
});

test.describe("settlements", () => {
  test("dine-in cash with change closes the order; the session then completes on the floor", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const server = await createRoleAccount("SERVER");
    const menu = await createOrderMenu(manager);
    const { tableNumber, sessionId } = await seatE2eParty(manager);
    const { orderId } = await sentOrderFor(manager, [menu.soda.id, menu.soda.id], { tableSessionId: sessionId });
    const ledgerBefore = await ledgerTypesFor(menu.pickles.id);

    await signIn(page, server);

    // The open check blocks the physical session completion.
    await page.goto("/restaurant/floor");
    await page.getByRole("listitem", { name: `Table ${tableNumber}` }).getByRole("button", { name: "Complete session" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "open order" })).toBeVisible();

    await openSettlementScreen(page, orderId, "$5.00");
    await expect(page.getByLabel("Amount due before tax")).toHaveText("$5.00");
    await expect(page.getByText("Tax isn't calculated in this version.")).toBeVisible();

    const form = tenderForm(page);

    await expect(form.getByLabel("Amount applied to the order")).toHaveValue("5.00");
    await form.getByLabel("Cash received").fill("20.00");
    await form.getByLabel("Tip (separate from the order)").fill("1.00");
    await expect(form.getByText("Change due: $14.00")).toBeVisible();
    await form.getByRole("button", { name: "Record cash" }).click();

    const tender = page.getByTestId("tender");

    await expect(tender).toContainText("Received $20.00 · Change $14.00");
    await expect(tender).toContainText("Tip $1.00");
    await expect(page.getByLabel("Remaining")).toHaveText("$0.00");

    await page.getByRole("button", { name: "Complete settlement and close order" }).click();
    await expectClosed(page, orderId);
    await expect(page.getByText(/complete it on the floor/)).toBeVisible();

    // Settlement moved no stock.
    expect(await ledgerTypesFor(menu.pickles.id)).toEqual(ledgerBefore);

    // Financially clear, but the table only turns over when the guests leave.
    await page.goto("/restaurant/floor");

    const card = page.getByRole("listitem", { name: `Table ${tableNumber}` });

    await expect(card).toContainText("Occupied");
    await card.getByRole("button", { name: "Complete session" }).click();
    await expect(card).toContainText("Dirty");
  });

  test("takeout with partial cash, then the rest on an external card", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const server = await createRoleAccount("SERVER");
    const menu = await createOrderMenu(manager);
    const { orderId } = await sentOrderFor(manager, [menu.soda.id, menu.soda.id]);

    await signIn(page, server);
    await openSettlementScreen(page, orderId, "$5.00");

    const form = tenderForm(page);

    await form.getByLabel("Amount applied to the order").fill("2.00");
    await form.getByLabel("Cash received").fill("2.00");
    await form.getByRole("button", { name: "Record cash" }).click();
    await expect(page.getByLabel("Remaining")).toHaveText("$3.00");

    await form.getByLabel("Tender type").selectOption("EXTERNAL_CARD");
    await expect(form.getByLabel("Amount applied to the order")).toHaveValue("3.00");
    await expect(form).toContainText("Never enter the card number, security code or PIN");
    // There is no card-number, CVV or PIN field to fill in.
    await expect(form.getByLabel(/card number|cvv|cvc|security code|pin/i)).toHaveCount(0);

    // A card number typed into a reference field is refused.
    await form.getByLabel("Authorization code (optional)").fill("4111111111111111");
    await form.getByRole("button", { name: "Record card (external terminal)" }).click();
    await expect(form.getByRole("alert")).toBeVisible();

    await form.getByLabel("Authorization code (optional)").fill("AUTH42");
    await form.getByLabel("Last four digits (optional)").fill("4242");
    await form.getByLabel("Card brand (optional)").fill("Visa");
    await form.getByRole("button", { name: "Record card (external terminal)" }).click();
    await expect(page.getByLabel("Remaining")).toHaveText("$0.00");
    await expect(page.getByTestId("tender")).toHaveCount(2);

    await page.getByRole("button", { name: "Complete settlement and close order" }).click();
    await expectClosed(page, orderId);
    // A takeout order has no table to turn over.
    await expect(page.getByRole("link", { name: "Go to the floor" })).toHaveCount(0);

    const stored = await tenderTextFor([orderId]);

    expect(stored).not.toMatch(/\d{13,}/);
    expect(stored).toContain("4242");
  });

  test("a fully comped order closes with a zero-amount settlement and no tender", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const menu = await createOrderMenu(manager);
    const { orderId, version } = await sentOrderFor(manager, [menu.soda.id]);

    await compOrder(manager, orderId, version);
    await signIn(page, manager);
    await openSettlementScreen(page, orderId, "$0.00");
    await expect(page.getByText("Discounts and comps reduced the amount due to $0.00.")).toBeVisible();
    await expect(tenderForm(page)).toHaveCount(0);

    await page.getByRole("button", { name: "Complete $0.00 settlement and close order" }).click();
    await expectClosed(page, orderId);
    await expect(page.getByText("No tender: the amount due was $0.00.")).toBeVisible();
  });

  test("a view-only user sees the settlement but can't record or complete, on screen or by API", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const viewer = await createPermissionAccount(["orders.view", "settlements.view"]);
    const menu = await createOrderMenu(manager);
    const { orderId } = await sentOrderFor(manager, [menu.soda.id]);

    await signIn(page, viewer);
    await page.goto(`/orders/${orderId}/settlement`);
    await expect(page.getByLabel("Amount due before tax")).toHaveText("$2.50");
    await expect(page.getByText("No settlement has been opened.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Open settlement/ })).toHaveCount(0);

    expect((await page.request.get(`/api/orders/${orderId}/settlement`)).status()).toBe(200);
    expect((await page.request.post(`/api/orders/${orderId}/settlements`)).status()).toBe(403);

    // The manager opens one; the viewer still can't add to it or complete it.
    await page.context().clearCookies();
    await signIn(page, manager);

    const opened = await (await page.request.post(`/api/orders/${orderId}/settlements`)).json();

    await page.context().clearCookies();
    await signIn(page, viewer);
    await page.goto(`/orders/${orderId}/settlement`);
    await expect(page.getByRole("region", { name: "Open settlement" })).toBeVisible();
    await expect(tenderForm(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Complete/ })).toHaveCount(0);

    const tender = await page.request.post(`/api/settlements/${opened.settlementId}/tenders`, {
      data: {
        expectedVersion: 1,
        idempotencyKey: "e2e-viewer-attempt-1",
        tenderType: "CASH",
        amount: "2.50",
        receivedAmount: "2.50",
      },
    });
    const complete = await page.request.post(`/api/settlements/${opened.settlementId}/complete`, {
      data: { expectedVersion: 1, idempotencyKey: "e2e-viewer-attempt-2" },
    });

    expect(tender.status()).toBe(403);
    expect(complete.status()).toBe(403);
    expect(await orderStatus(orderId)).toBe("OPEN");

    await page.context().clearCookies();
    expect((await page.request.get(`/api/orders/${orderId}/settlement`)).status()).toBe(401);
  });
});
