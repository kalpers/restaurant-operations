import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  createSignalsSetup,
  disableSignalsAccounts,
  useFryerOil,
  type SignalsSetup,
} from "../helpers/e2e-menu-signals";
import type { OrdersAccount } from "../helpers/e2e-orders";

// Phase 19: the 86 board, auto-86 with sell anyway, a low-stock alert turned into a draft
// order, and what a Server may not do. Everything runs at this spec's own location.

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "America/Detroit" });

let setup: SignalsSetup;

async function signedIn(browser: Browser, account: OrdersAccount): Promise<Page> {
  const page = await (await browser.newContext({ timezoneId: "America/Detroit" })).newPage();

  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect((await page.request.put("/api/session/location", { data: { locationId: setup.locationId } })).ok()).toBe(true);

  return page;
}

async function offeredIds(page: Page): Promise<string[]> {
  const response = await page.request.get("/api/menu/operational");

  expect(response.ok()).toBe(true);

  const menu = (await response.json()) as { menus: { categories: { items: { menuItemId: string }[] }[] }[] };

  return menu.menus.flatMap((entry) => entry.categories.flatMap((category) => category.items.map((item) => item.menuItemId)));
}

test.beforeAll(async () => {
  setup = await createSignalsSetup();
});

test.afterAll(async () => {
  await disableSignalsAccounts();
});

test("the cook 86es an item, the server can't sell it or 86 anything, and the cook restores it", async ({ browser }) => {
  test.setTimeout(90_000);

  const cook = await signedIn(browser, setup.cook);
  const server = await signedIn(browser, setup.server);

  await cook.goto("/menu/86");
  await expect(cook.getByRole("heading", { name: "86 board" })).toBeVisible();

  const form = cook.getByRole("region", { name: "86 an item" });

  await form.getByLabel("Item").selectOption(setup.fries.id);
  await form.getByLabel("Reason").fill("Fryer down");
  await form.getByRole("button", { name: "86 item" }).click();

  const out = cook.getByRole("region", { name: "86'd now" });

  await expect(out.getByRole("listitem", { name: `86'd ${setup.fries.name}` })).toContainText("Fryer down");
  expect(await offeredIds(server)).not.toContain(setup.fries.id);

  // The server sees the board but none of its actions, and the API refuses them.
  await server.goto("/menu/86");
  await expect(server.getByRole("region", { name: "86'd now" })).toContainText(setup.fries.name);
  await expect(server.getByRole("region", { name: "86 an item" })).toHaveCount(0);
  await expect(server.getByRole("button", { name: `Restore ${setup.fries.name}` })).toHaveCount(0);
  expect(
    (await server.request.post("/api/menu/outages", { data: { menuItemId: setup.special.id, reason: "Not mine to 86" } })).status(),
  ).toBe(403);

  await out.getByRole("button", { name: `Restore ${setup.fries.name}` }).click();
  await expect(cook.getByRole("region", { name: "Restored today" })).toContainText(setup.fries.name);
  expect(await offeredIds(server)).toContain(setup.fries.id);
});

test("auto-86 takes an item with no stock off sale, and sell anyway puts it back for the day", async ({ browser }) => {
  test.setTimeout(90_000);

  const owner = await signedIn(browser, setup.owner);
  const manager = await signedIn(browser, setup.manager);

  expect(await offeredIds(manager)).toContain(setup.special.id);

  await owner.goto("/menu/86");
  await owner.getByRole("region", { name: "Auto-86 setting" }).getByRole("button", { name: "Turn auto-86 on" }).click();
  await expect(owner.getByRole("button", { name: "Turn auto-86 off" })).toBeVisible();
  expect(await offeredIds(manager)).not.toContain(setup.special.id);

  await manager.goto("/menu/86");

  const special = manager.getByRole("listitem", { name: `86'd ${setup.special.name}` });

  await expect(special).toContainText("Out of stock");
  await special.getByLabel("Why sell anyway?").fill("Delivery in the walk-in, not counted yet");
  await special.getByRole("button", { name: `Sell ${setup.special.name} anyway today` }).click();
  await expect(manager.getByRole("region", { name: "Sell anyway today" })).toContainText(setup.special.name);
  expect(await offeredIds(manager)).toContain(setup.special.id);
});

test("a low-stock alert reaches the manager, who turns it into a draft order", async ({ browser }) => {
  test.setTimeout(90_000);

  const manager = await signedIn(browser, setup.manager);

  await useFryerOil(setup);
  await manager.goto("/inventory/low-stock");
  await expect(manager.getByRole("listitem", { name: `Low stock ${setup.oil.name}` })).toContainText("Alert since");

  await manager.getByRole("button", { name: /^Alerts, [1-9]\d* unread$/ }).click();
  await expect(manager.getByText(`Low stock: ${setup.oil.name}`)).toBeVisible();

  await manager.goto("/purchasing/suggested");

  const group = manager.getByRole("region", { name: /^Suggested from E2E Supply/ });

  // 24 target - 5 on hand = 19, in whole units of 1.
  await expect(group).toContainText(setup.oil.name);
  await expect(group).toContainText("19 EACH");
  await manager.getByRole("button", { name: "Create draft orders" }).click();
  await expect(manager.getByRole("list", { name: "Created drafts" })).toContainText(/PO-\d+/);

  // Nothing is left to suggest once the draft is on order.
  await manager.reload();
  await expect(manager.getByRole("region", { name: /^Suggested from E2E Supply/ })).toHaveCount(0);
});

test("the new report sections render for the location", async ({ browser }) => {
  const owner = await signedIn(browser, setup.owner);

  await owner.goto("/reports/sales");
  await expect(owner.getByRole("heading", { name: "Sales by hour" })).toBeVisible();
  await owner.goto("/reports/orders");
  await expect(owner.getByRole("heading", { name: "Server performance" })).toBeVisible();
  await expect(owner.getByRole("heading", { name: "Voids, comps and discounts by employee" })).toBeVisible();
  await owner.goto("/reports/inventory");
  await expect(owner.getByRole("heading", { name: "86 history" })).toBeVisible();
  await expect(owner.getByText("Fryer down")).toBeVisible();

  const csv = await owner.request.get(
    `/api/reports/menu/export?locationId=${setup.locationId}&from=${new Date().toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`,
  );

  expect(csv.status()).toBeLessThan(500);
});
