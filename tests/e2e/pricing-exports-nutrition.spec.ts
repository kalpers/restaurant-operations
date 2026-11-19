import { expect, test, type Page } from "@playwright/test";

import {
  createOrderMenu,
  createPermissionAccount,
  createRoleAccount,
  removeOrdersE2eData,
  sentOrderFor,
  settleInCashFor,
  takeoutWithDraft,
  type OrdersAccount,
} from "../helpers/e2e-orders";
import { emptyTakeout, mainLocalClock, PHASE28_SCOPE } from "../helpers/e2e-phase28";
import { clickUntilShown, expectToast, signInWithRetry } from "../helpers/e2e-ui";

// Phase 28: a manager sets up a happy hour and a server sells at its price; the Sales report
// shows the new sections; the Exports page downloads both files; nutrition entered for an
// ingredient shows on the menu item page and in the order dialog.

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "America/Detroit" });

let owner: OrdersAccount;
let menu: Awaited<ReturnType<typeof createOrderMenu>>;

async function signIn(page: Page, account: OrdersAccount) {
  await signInWithRetry(page, account);
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  owner = await createRoleAccount("OWNER", PHASE28_SCOPE);
  menu = await createOrderMenu(owner);
});

test.afterAll(async () => {
  await removeOrdersE2eData(PHASE28_SCOPE);
});

test("a manager sets up a takeout happy hour and the server sends at its price", async ({ page }) => {
  test.setTimeout(120_000);

  const manager = await createPermissionAccount(["menu.view", "menu.pricing.view", "menu.pricing.edit"], PHASE28_SCOPE);
  const start = await mainLocalClock(-60);
  const end = await mainLocalClock(60);
  const name = `HH ${Date.now() % 100000}`;

  await signIn(page, manager);
  await page.goto("/menu/happy-hour");
  await expect(page.getByRole("heading", { name: "Happy hour", level: 1 })).toBeVisible();

  const form = page.getByRole("form", { name: "Add a price period" });

  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Starts (local time)").fill(start);
  await form.getByLabel("Ends (local time)").fill(end);

  for (const day of ["Sun", "Sat"]) {
    await form.getByLabel(day, { exact: true }).check();
  }

  await form.getByLabel("Takeout").check();
  await form.getByLabel("Item 1").selectOption({ value: menu.soda.id });
  await form.getByLabel("Price 1").fill("1.00");
  await clickUntilShown(form.getByRole("button", { name: "Add price period" }), () =>
    expect(page.getByRole("region", { name: `Price period ${name}` })).toBeVisible({ timeout: 5_000 }),
  );
  await expect(page.getByRole("region", { name: `Price period ${name}` })).toContainText(`${menu.soda.name}: $1.00`);

  // The server's takeout check shows the period on the menu and sends at its price.
  const server = await createRoleAccount("SERVER", PHASE28_SCOPE);
  const orderId = await emptyTakeout(owner);

  await page.context().clearCookies();
  await signIn(page, server);
  await page.goto(`/orders/${orderId}`);

  const menuRegion = page.getByRole("region", { name: "Menu" });

  await menuRegion.getByRole("tab", { name: menu.categoryName }).click();
  await expect(menuRegion.getByRole("button", { name: new RegExp(menu.soda.name) })).toContainText(`${name} until`);
  await menuRegion.getByRole("button", { name: new RegExp(menu.soda.name) }).click();

  const picker = page.getByRole("form", { name: `Add ${menu.soda.name}` });

  await expect(picker).toContainText("Regular $2.50");
  await picker.getByRole("button", { name: "Add to order" }).click();
  await expect(page.getByRole("listitem", { name: `Unsent ${menu.soda.name}` })).toContainText("$1.00");
});

test("the Sales report shows the price periods and the sales forecast", async ({ page }) => {
  const reporter = await createPermissionAccount(["reports.view", "reports.sales", "reports.export"], PHASE28_SCOPE);

  await signIn(page, reporter);
  await page.goto("/reports/sales");
  await expect(page.getByRole("heading", { name: "Price periods" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sales forecast (next 14 days)" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sales forecast vs actual" })).toBeVisible();
});

test("the Exports page downloads the sales journal and the payroll hours file", async ({ page }) => {
  test.setTimeout(90_000);

  const { orderId } = await sentOrderFor(owner, [menu.soda.id]);

  await settleInCashFor(owner, orderId);

  const exporter = await createPermissionAccount(
    ["reports.view", "reports.export", "reports.sales", "reports.settlements", "reports.labor"],
    PHASE28_SCOPE,
  );

  await signIn(page, exporter);
  await page.goto("/reports/exports");
  await expect(page.getByRole("heading", { name: "Exports", level: 1 })).toBeVisible();

  // The journal defaults to yesterday's business date; an empty day is still a valid file.
  const journal = page.getByRole("form", { name: "Sales journal" });
  const [journalFile] = await Promise.all([
    page.waitForEvent("download"),
    journal.getByRole("button", { name: /Download sales journal/ }).click(),
  ]);

  expect(journalFile.suggestedFilename()).toMatch(/^sales-journal_MAIN_.+\.csv$/);

  // A past week with no time entries (weeks start on Monday by default): 2020-01-06 to 01-12.
  const payroll = page.getByRole("form", { name: "Payroll hours" });

  await payroll.getByLabel("First day (start of a work week)").fill("2020-01-06");
  await payroll.getByLabel("Last day (end of a work week)").fill("2020-01-12");

  const [payrollFile] = await Promise.all([
    page.waitForEvent("download"),
    payroll.getByRole("button", { name: /Download payroll hours/ }).click(),
  ]);

  expect(payrollFile.suggestedFilename()).toMatch(/^payroll-hours_MAIN_.+\.csv$/);

  // A range that isn't whole weeks is refused beside the form.
  await payroll.getByLabel("First day (start of a work week)").fill("2020-01-07");
  await payroll.getByLabel("Last day (end of a work week)").fill("2020-01-13");
  await payroll.getByRole("button", { name: /Download payroll hours/ }).click();
  await expect(payroll).toContainText(/whole work weeks/);
});

test("nutrition entered for an ingredient shows on the menu item page and in the order dialog", async ({ page }) => {
  test.setTimeout(120_000);

  const chef = await createPermissionAccount(
    ["menu.view", "menu.edit", "inventory.view", "inventory.configure", "recipes.view", "recipes.edit"],
    PHASE28_SCOPE,
  );

  await signIn(page, chef);
  await page.goto(`/inventory/items/${menu.beef.id}`);

  const section = page.getByRole("region", { name: "Nutrition facts" });

  await section.getByLabel("Calories").fill("300");
  await clickUntilShown(section.getByRole("button", { name: "Save nutrition" }), () => expectToast(page, "Nutrition saved."));

  // Beef has data, pickles don't: the label is incomplete and says so.
  await page.goto(`/menu/items/${menu.burger.id}`);

  const label = page.getByRole("region", { name: "Nutrition" });

  await expect(label).toContainText("Incomplete");
  await expect(label).toContainText(/At least 300 \(1 ingredient without data\)/);

  // The server sees calories for the choices made.
  const server = await createRoleAccount("SERVER", PHASE28_SCOPE);
  const { orderId } = await takeoutWithDraft(owner, menu.soda.id);

  await page.context().clearCookies();
  await signIn(page, server);
  await page.goto(`/orders/${orderId}`);

  const menuRegion = page.getByRole("region", { name: "Menu" });

  await menuRegion.getByRole("tab", { name: menu.categoryName }).click();
  await menuRegion.getByRole("button", { name: new RegExp(menu.burger.name) }).click();

  const picker = page.getByRole("form", { name: `Add ${menu.burger.name}` });

  await expect(picker).toContainText("Make the required choices to see nutrition.");
  await picker.getByLabel("Medium").check();
  await expect(picker).toContainText("Calories: At least 300");
});
