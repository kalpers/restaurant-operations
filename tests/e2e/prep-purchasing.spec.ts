import { expect, test, type Page } from "@playwright/test";

import { createPermissionAccount, type OrdersAccount } from "../helpers/e2e-orders";
import { createPrepFixture, PREP_SCOPE, removePrepE2eData, type PrepFixture } from "../helpers/e2e-prep-forecast";
import { clickUntilShown, signInWithRetry } from "../helpers/e2e-ui";

// Phase 25: a cook reads the prep list for a station, and a purchasing manager orders from the
// forecast. History is made through the real services in this process (see the helper); the
// app's own clock is untouched. The item forecast vs actual report needs a stored forecast on a
// past date, which the integration tests cover.

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "America/Detroit" });

let fixture: PrepFixture;

async function signIn(page: Page, account: OrdersAccount) {
  await signInWithRetry(page, account);
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  fixture = await createPrepFixture();
});

test.afterAll(async () => {
  await removePrepE2eData();
});

test("a cook reads the station's prep list: forecast portions and the ingredients they take", async ({ page }) => {
  const cook = await createPermissionAccount(["kitchen.view"], PREP_SCOPE);

  await signIn(page, cook);
  await page.goto("/kitchen/prep");
  await expect(page.getByRole("heading", { name: "Prep list", level: 1 })).toBeVisible();

  // Under `next dev` a submit before hydration still works (a plain GET form).
  await page.getByLabel("Business date").fill(fixture.target);
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page).toHaveURL(new RegExp(`date=${fixture.target}`));

  const station = page.getByRole("region", { name: `Prep for ${fixture.stationName}` });
  const row = station.getByRole("row", { name: new RegExp(fixture.burgerName) });

  await expect(row).toContainText("4");
  await expect(row).toContainText(`${fixture.pattyName}: 4 EACH`);
  await expect(page.getByRole("button", { name: "Show" })).toBeVisible();
});

test("a purchasing manager orders from the forecast: a forecast line that par levels would miss", async ({ page }) => {
  test.setTimeout(90_000);

  const buyer = await createPermissionAccount(["purchasing.view", "purchasing.manage", "inventory.view"], PREP_SCOPE);

  await signIn(page, buyer);

  // Par levels alone: 8 patties on hand is above the reorder level of 5, so nothing for them.
  await page.goto("/purchasing/suggested");
  await expect(page.getByRole("heading", { name: "Suggested orders", level: 1 })).toBeVisible();
  await expect(page.getByText(fixture.pattyName)).toHaveCount(0);

  // From the forecast through the target date: 4 forecast + 5 reorder level - 8 on hand = 1.
  await page.goto(`/purchasing/suggested?basis=forecast&through=${fixture.target}`);

  const line = page.getByRole("row", { name: new RegExp(fixture.pattyName) });

  await expect(line).toContainText("Forecast");
  await expect(line).toContainText("4 EACH");
  await expect(line).toContainText("1 EACH");

  await clickUntilShown(page.getByRole("button", { name: "Create draft orders" }), () =>
    expect(page.getByRole("list", { name: "Created drafts" })).toContainText(/PO-\d+/, { timeout: 5_000 }),
  );
  await page.getByRole("list", { name: "Created drafts" }).getByRole("link").first().click();
  await expect(page.getByLabel("Order status")).toContainText("Draft");
  await expect(page.getByRole("listitem", { name: `Order line ${fixture.pattyName}` })).toContainText("Ordered 1 EACH");
});
