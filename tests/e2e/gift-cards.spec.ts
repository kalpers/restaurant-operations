import { expect, test, type Browser, type Page } from "@playwright/test";

import { createGuestsSetup, disableGuestsAccounts, type GuestsSetup } from "../helpers/e2e-guests";
import { takeoutCheck, turnGiftCardsOff } from "../helpers/e2e-gift-cards";
import type { OrdersAccount } from "../helpers/e2e-orders";
import { expandNavGroups, signInWithRetry } from "../helpers/e2e-ui";

// Phase 31: a manager turns gift cards on; a server sells a $50 card and sees its code once;
// the card pays $5 of a check with the rest on a card; the manager finds the card by number
// and sees $45 left with its history.

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "America/Detroit" });

let setup: GuestsSetup;

async function signedIn(browser: Browser, account: OrdersAccount): Promise<Page> {
  const page = await (await browser.newContext({ timezoneId: "America/Detroit" })).newPage();

  await signInWithRetry(page, account);
  expect((await page.request.put("/api/session/location", { data: { locationId: setup.locationId } })).ok()).toBe(true);

  return page;
}

test.beforeAll(async () => {
  setup = await createGuestsSetup();
});

test.afterAll(async () => {
  await turnGiftCardsOff(setup);
  await disableGuestsAccounts(setup);
});

test("a card is sold with its code shown once, pays part of a check, and keeps the rest", async ({ browser }) => {
  test.setTimeout(180_000);

  const manager = await signedIn(browser, setup.manager);

  // The Gift cards page is in the Service group.
  await manager.goto("/dashboard");
  await expandNavGroups(manager);
  await manager.getByRole("link", { name: "Gift cards" }).click();
  await expect(manager.getByRole("heading", { name: "Gift cards" })).toBeVisible();

  const settings = manager.getByRole("region", { name: "Gift card settings" });

  await settings.getByLabel("Sell and accept the restaurant's own gift cards").check();
  await settings.getByRole("button", { name: "Save settings" }).click();
  await expect(manager.getByText("On", { exact: true })).toBeVisible();

  // The server sells a $50 card paid on the external terminal; the code appears once.
  const server = await signedIn(browser, setup.server);

  await server.goto("/gift-cards");

  const sell = server.getByRole("region", { name: "Sell or reload a gift card" });

  await sell.getByLabel(/^Amount/).fill("50.00");
  await sell.getByLabel("Guest paid by").selectOption("EXTERNAL_CARD");
  await sell.getByRole("button", { name: "Sell card" }).click();

  const code = (await server.getByLabel("Gift card code", { exact: true }).last().textContent())!.trim();

  expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
  await expect(sell.getByText(/Sold GC-\d{6}: balance \$50\.00/)).toBeVisible();

  const cardNumber = (await sell.getByText(/Sold GC-\d{6}/).textContent())!.match(/GC-\d{6}/)![0];

  await server.getByRole("button", { name: "I've written it down" }).click();
  await expect(server.getByText(code)).toHaveCount(0);

  // The card pays $5.00 of the satay check; the rest goes on the external terminal.
  const orderId = await takeoutCheck(setup, setup.satay.id);

  await server.goto(`/orders/${orderId}/settlement`);
  await server.getByRole("button", { name: /Open settlement for/ }).click();

  const tenderForm = server.getByRole("form", { name: "Record tender" });

  await tenderForm.getByLabel("Tender type").selectOption("GIFT_CARD");
  await tenderForm.getByLabel("Gift card code").fill(code.toLowerCase());
  await tenderForm.getByRole("button", { name: "Check balance" }).click();
  await expect(tenderForm.getByText(`${cardNumber} holds $50.00`)).toBeVisible();
  await tenderForm.getByLabel("Amount applied to the order").fill("5.00");
  await tenderForm.getByRole("button", { name: "Record gift card" }).click();
  await expect(server.getByTestId("tender").filter({ hasText: `Gift card ${cardNumber}` })).toBeVisible();

  await server.getByRole("button", { name: /Card – exact/ }).click();
  await server.getByRole("button", { name: "Record card (external terminal)" }).click();
  await server.getByRole("button", { name: "Complete settlement and close order" }).click();
  await expect(server.getByTestId("order-status")).toHaveText("Closed");
  await expect(server.getByRole("region", { name: "Completed settlement" })).toBeVisible();

  // The manager finds the card by its number: $45.00 left, with its history.
  await manager.goto("/gift-cards");
  await manager.getByLabel("Card number (from the receipt)").fill(cardNumber);
  await manager.getByRole("button", { name: "Find by number" }).click();

  const card = manager.getByRole("region", { name: `Gift card ${cardNumber}` });

  await expect(card.getByLabel("Gift card balance")).toHaveText("$45.00");
  await expect(card.getByRole("list", { name: "Card history" })).toContainText("Spent on a check");
  await expect(card.getByRole("list", { name: "Card history" })).toContainText("Sold");
});

// Phase 33 (policies 13, 14): a card from a supplier keeps the code printed on it.
test("a pre-printed card is sold with its own code and found by it", async ({ browser }) => {
  test.setTimeout(120_000);

  const printed = `PRE-${setup.suffix.toUpperCase()}-CARD`;
  const server = await signedIn(browser, setup.server);

  await server.goto("/gift-cards");

  const sell = server.getByRole("region", { name: "Sell or reload a gift card" });

  await sell.getByLabel("Use the code printed on the card").check();
  await sell.getByLabel(/^Printed code/).fill(printed);
  await sell.getByLabel(/^Amount/).fill("20.00");
  await sell.getByLabel("Guest paid by").selectOption("EXTERNAL_CARD");
  await sell.getByRole("button", { name: "Sell card" }).click();
  await expect(sell.getByText(/Sold GC-\d{6}: balance \$20\.00/)).toBeVisible();
  // Nothing to write down: the code is on the card.
  await expect(server.getByRole("button", { name: "I've written it down" })).toHaveCount(0);

  const lookup = server.getByRole("region", { name: "Look up a gift card" });

  await lookup.getByLabel("Card code").fill(printed.toLowerCase().replaceAll("-", " "));
  await lookup.getByRole("button", { name: "Check balance" }).click();
  await expect(server.getByLabel("Gift card balance")).toHaveText("$20.00");
});

// Phase 34 (policies 3–10): printed card stock, purchaser details and an unclaimed report.
test("printed cards are registered as stock and one is sold by its code", async ({ browser }) => {
  test.setTimeout(150_000);

  const code = (index: number) => `BOX${setup.suffix.toUpperCase()}${index}ZZ`;
  const owner = await signedIn(browser, setup.owner);

  await owner.goto("/gift-cards");

  const stock = owner.getByRole("region", { name: "Card stock" });

  await stock.getByLabel("Batch (supplier or box)").fill(`E2E box ${setup.suffix}`);
  await stock.getByLabel(/^Codes/).fill(`S-1,${code(1)}\nS-2,${code(2)}`);
  await stock.getByRole("button", { name: "Register cards" }).click();
  await expect(stock.getByText(/Registered GCB-\d{6}: 2 cards/)).toBeVisible();
  await expect(stock.getByRole("list", { name: "Stock batches" })).toContainText(`E2E box ${setup.suffix} · 2 registered, 0 sold, 2 unsold`);
  // The codes aren't shown again.
  await expect(owner.getByText(code(1))).toHaveCount(0);

  const server = await signedIn(browser, setup.server);

  await server.goto("/gift-cards");

  const sell = server.getByRole("region", { name: "Sell or reload a gift card" });

  await sell.getByLabel("Use the code printed on the card").check();
  await sell.getByLabel(/^Printed code/).fill(code(1).toLowerCase());
  await sell.getByLabel(/^Amount/).fill("30.00");
  await sell.getByLabel("Guest paid by").selectOption("EXTERNAL_CARD");
  await sell.getByRole("button", { name: "Sell card" }).click();
  await expect(sell.getByText(/Sold GC-\d{6}: balance \$30\.00/)).toBeVisible();

  await owner.reload();
  await expect(owner.getByRole("list", { name: "Stock batches" })).toContainText(`E2E box ${setup.suffix} · 2 registered, 1 sold, 1 unsold`);
});

test("a card sold with purchaser details is reported as unclaimed", async ({ browser }) => {
  test.setTimeout(150_000);

  const server = await signedIn(browser, setup.server);

  await server.goto("/gift-cards");

  const sell = server.getByRole("region", { name: "Sell or reload a gift card" });

  await sell.getByLabel(/^Amount/).fill("12.00");
  await sell.getByLabel("Guest paid by").selectOption("EXTERNAL_CARD");
  await sell.getByText("Purchaser details (optional)").click();
  await sell.getByLabel("Name", { exact: true }).fill(`Robin Buyer ${setup.suffix}`);
  await sell.getByLabel("City").fill("Lansing");
  await sell.getByRole("button", { name: "Sell card" }).click();

  const sold = sell.getByText(/Sold GC-\d{6}: balance \$12\.00/);

  await expect(sold).toBeVisible();

  const cardNumber = (await sold.textContent())!.match(/GC-\d{6}/)![0];

  await server.getByRole("button", { name: "I've written it down" }).click();

  const owner = await signedIn(browser, setup.owner);

  await owner.goto("/gift-cards");
  await owner.getByLabel("Card number (from the receipt)").fill(cardNumber);
  await owner.getByRole("button", { name: "Find by number" }).click();

  const card = owner.getByRole("region", { name: `Gift card ${cardNumber}` });
  const purchaser = card.getByRole("region", { name: "Purchaser details" });

  await purchaser.getByRole("button", { name: "Show purchaser details" }).click();
  await expect(purchaser).toContainText(`Robin Buyer ${setup.suffix}`);
  await expect(purchaser).toContainText("Lansing");

  await card.getByRole("button", { name: "Report as unclaimed" }).click();
  await card.getByLabel("State (two letters)").fill("mi");
  await card.getByLabel("Filing reference").fill(`E2E-${setup.suffix}`);
  await card.getByLabel("Date reported").fill("2026-11-01");
  await card.getByRole("button", { name: "Confirm" }).click();

  const reloaded = owner.getByRole("region", { name: `Gift card ${cardNumber}` });

  await expect(reloaded.getByLabel("Gift card balance")).toHaveText("$0.00");
  await expect(reloaded.getByRole("list", { name: "Card history" })).toContainText("Reported as unclaimed");

  // The Owner can export the holder report.
  await owner.goto("/reports/exports");
  await expect(owner.getByRole("form", { name: "Holder report" })).toBeVisible();
});
