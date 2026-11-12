import { expect, test, type Browser, type Page } from "@playwright/test";

import type { OrdersAccount } from "../helpers/e2e-orders";
import {
  createPolishSetup,
  disablePolishAccounts,
  seatPolishParty,
  sentCheck,
  settleByCard,
  type PolishSetup,
} from "../helpers/e2e-service-polish";
import { detroitLocal } from "../helpers/e2e-timeclock";

// Phase 20: modifier and scheduled 86, tax included in prices and tax-exempt checks, one item
// shared between checks, a tip refund, and the stale-data Reload. All at this spec's location.

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "America/Detroit" });

let setup: PolishSetup;

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

async function offered(page: Page) {
  const response = await page.request.get("/api/menu/operational");

  expect(response.ok()).toBe(true);

  const menu = (await response.json()) as {
    menus: { categories: { items: { menuItemId: string; modifierGroups: { modifiers: { id: string }[] }[] }[] }[] }[];
  };

  return menu.menus.flatMap((entry) => entry.categories.flatMap((category) => category.items));
}

test.beforeAll(async () => {
  setup = await createPolishSetup();
});

test.afterAll(async () => {
  await disablePolishAccounts();
});

test("the cook 86es a modifier and schedules an item 86 for later", async ({ browser }) => {
  test.setTimeout(90_000);

  const cook = await signedIn(browser, setup.cook);

  await cook.goto("/menu/86");

  const modifierForm = cook.getByRole("region", { name: "86 a modifier" });

  await modifierForm.getByLabel("Modifier").selectOption(setup.burger.wellDone.id);
  await modifierForm.getByLabel("Reason").fill("Grill too slow tonight");
  await modifierForm.getByRole("button", { name: "86 modifier" }).click();
  await expect(cook.getByRole("region", { name: "Modifiers 86'd now" })).toContainText(setup.burger.wellDone.name);

  const burger = (await offered(cook)).find((item) => item.menuItemId === setup.burger.id)!;

  expect(burger.modifierGroups.flatMap((group) => group.modifiers.map((modifier) => modifier.id))).not.toContain(
    setup.burger.wellDone.id,
  );

  // An 86 that starts in two hours leaves the item on sale for now.
  const itemForm = cook.getByRole("region", { name: "86 an item" });

  await itemForm.getByLabel("Item").selectOption(setup.lemonade.id);
  await itemForm.getByLabel("Reason").fill("Off after the rush");
  await itemForm.getByLabel("Starts (location time; blank is now)").fill(detroitLocal(new Date(Date.now() + 2 * 3_600_000)));
  await itemForm.getByRole("button", { name: "86 item" }).click();
  await expect(cook.getByRole("region", { name: "Scheduled 86" })).toContainText(setup.lemonade.name);
  expect((await offered(cook)).map((item) => item.menuItemId)).toContain(setup.lemonade.id);

  // Restore both.
  await cook.getByRole("region", { name: "Modifiers 86'd now" }).getByRole("button", { name: `Restore ${setup.burger.wellDone.name}` }).click();
  await expect(cook.getByRole("region", { name: "Modifiers 86'd now" })).toHaveCount(0);
  await cook.getByRole("region", { name: "Scheduled 86" }).getByRole("button", { name: `Cancel the 86 of ${setup.lemonade.name}` }).click();
  await expect(cook.getByRole("region", { name: "Scheduled 86" })).toHaveCount(0);
});

test("tax included in a price, tax added on top, and a tax-exempt check", async ({ browser }) => {
  test.setTimeout(90_000);

  const sessionId = await seatPolishParty(setup);
  const orderId = await sentCheck(setup, sessionId, ["lemonade", "burger"]);
  const manager = await signedIn(browser, setup.manager);

  await manager.goto(`/orders/${orderId}`);

  const totals = manager.getByRole("region", { name: "Totals" });

  // 11.00 includes 1.00; 10.00 gets 1.00 added: subtotal 20.00, tax 2.00, total 22.00.
  await expect(totals.getByLabel("Subtotal")).toHaveText("$20.00");
  await expect(totals.getByLabel("Tax", { exact: true })).toHaveText("$2.00");
  await expect(totals.getByLabel("Tax included in prices")).toHaveText("$1.00");
  await expect(totals.getByLabel("Order total")).toHaveText("$22.00");

  await totals.locator("summary", { hasText: "Make tax exempt" }).click();

  const exempt = totals.getByRole("form", { name: "Make tax exempt" });

  await exempt.getByLabel("Reason").fill("School district event");
  await exempt.getByLabel("Exemption certificate reference (optional)").fill("EX-2041");
  await exempt.getByRole("button", { name: "Make tax exempt" }).click();
  await expect(totals.getByLabel("Order total")).toHaveText("$20.00");
  await expect(totals).toContainText("Tax exempt: School district event");

  // A server can't make a check tax exempt.
  const server = await signedIn(browser, setup.server);

  expect(
    (await server.request.post(`/api/orders/${orderId}/tax-exemption`, { data: { reason: "Please", expectedVersion: 1 } })).status(),
  ).toBe(403);
});

test("a stale edit offers Reload, which brings in the other change", async ({ browser }) => {
  test.setTimeout(90_000);

  const sessionId = await seatPolishParty(setup);
  const orderId = await sentCheck(setup, sessionId, ["burger"]);
  const first = await signedIn(browser, setup.manager);
  const second = await signedIn(browser, setup.manager);

  // The second screen gets no realtime refresh, so it is still showing the old version when it
  // submits: the case Reload exists for (a dropped connection, or a change between refreshes).
  await second.route("**/api/realtime/stream", (route) => route.abort());
  await first.goto(`/orders/${orderId}`);
  await second.goto(`/orders/${orderId}`);

  for (const page of [first, second]) {
    await page.getByRole("region", { name: "Totals" }).locator("summary", { hasText: "Make tax exempt" }).click();
    await page.getByRole("form", { name: "Make tax exempt" }).getByLabel("Reason").fill("Exempt guest");
  }

  await first.getByRole("form", { name: "Make tax exempt" }).getByRole("button", { name: "Make tax exempt" }).click();
  await expect(first.getByRole("region", { name: "Totals" })).toContainText("Tax exempt");

  await second.getByRole("form", { name: "Make tax exempt" }).getByRole("button", { name: "Make tax exempt" }).click();

  const alert = second.getByRole("alert").filter({ hasText: /changed|someone else|reload/i });

  await expect(alert).toBeVisible();
  await alert.getByRole("button", { name: "Reload" }).click();
  await expect(second.getByRole("region", { name: "Totals" })).toContainText("Tax exempt: Exempt guest");
});

test("one burger is shared between two checks, and both settle", async ({ browser }) => {
  test.setTimeout(120_000);

  const sessionId = await seatPolishParty(setup);
  const firstId = await sentCheck(setup, sessionId, ["burger"]);
  const secondId = await sentCheck(setup, sessionId, []);
  const manager = await signedIn(browser, setup.manager);

  await manager.goto(`/orders/${firstId}`);
  await manager.getByRole("listitem", { name: `Sent ${setup.burger.name}` }).getByRole("button", { name: "Share between checks" }).click();

  const dialog = manager.getByRole("dialog");

  await dialog.getByLabel("Share 1 goes on").selectOption("THIS");
  await dialog.getByLabel("Share 2 goes on").selectOption(secondId);
  await dialog.getByRole("button", { name: "Share item" }).click();

  const shares = manager.getByRole("list", { name: `Shares of ${setup.burger.name}` });

  await expect(shares).toContainText("Share 1/2");
  await expect(shares).toContainText("on check #");
  // 10.00 shared: 5.00 each, plus 10% tax added: 5.50 on each check.
  await expect(manager.getByRole("region", { name: "Totals" }).getByLabel("Order total")).toHaveText("$5.50");

  await manager.goto(`/orders/${secondId}`);
  await expect(manager.getByRole("region", { name: "Shared items" })).toContainText(setup.burger.name);
  await expect(manager.getByRole("region", { name: "Totals" }).getByLabel("Order total")).toHaveText("$5.50");

  expect(await settleByCard(setup, firstId)).toBe("5.50");
  expect(await settleByCard(setup, secondId)).toBe("5.50");
});

test("a manager refunds part of a tip on a closed check", async ({ browser }) => {
  test.setTimeout(90_000);

  const sessionId = await seatPolishParty(setup);
  const orderId = await sentCheck(setup, sessionId, ["lemonade"]);

  await settleByCard(setup, orderId, "3.00");

  const manager = await signedIn(browser, setup.manager);

  await manager.goto(`/orders/${orderId}/settlement`);

  const form = manager.getByRole("form", { name: "Record refund" });

  await form.getByLabel("Refunded as").selectOption("EXTERNAL_CARD");
  await form.getByLabel("Tip refunded (separate)").fill("1.00");
  await form.getByLabel("Reason").fill("Tip entered twice");
  await form.getByRole("button", { name: "Record refund" }).click();
  await expect(manager.getByTestId("refund")).toContainText("tip $1.00");
});
