import { expect, test } from "@playwright/test";

import { disableBriefingsAccounts } from "../helpers/e2e-briefings";
import { createCombo } from "../helpers/e2e-bundles";
import { createOrderMenu, createRoleAccount, seatE2eParty, type E2eScope } from "../helpers/e2e-orders";
import { signInWithRetry } from "../helpers/e2e-ui";

// Phase 36 part 5: a server adds a combo, choosing the burger's temperature inside it; the check
// shows one priced line with its courses labelled; sending sends every course; the total is the
// combo's price plus the drink's upcharge.

const SCOPE: E2eScope = { emailDomain: "prixfixe-e2e.example.test", rolePrefix: "PRIXFIXE_E2E_", tablePrefix: "PFX-" };

test.afterAll(async () => {
  await disableBriefingsAccounts(SCOPE);
});

test("a combo is chosen course by course and sent as one priced line", async ({ page }) => {
  test.setTimeout(120_000);

  const owner = await createRoleAccount("OWNER", SCOPE);
  const server = await createRoleAccount("SERVER", SCOPE);
  const menu = await createOrderMenu(owner);
  const combo = await createCombo(owner, { burgerId: menu.burger.id, sodaId: menu.soda.id });
  const { tableNumber } = await seatE2eParty(owner, SCOPE);

  await signInWithRetry(page, server);
  await page.goto("/restaurant/floor");
  await page.getByRole("listitem", { name: `Table ${tableNumber}` }).getByRole("link", { name: "Orders" }).click();
  await page.getByRole("button", { name: "New dine-in order" }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);

  const menuRegion = page.getByRole("region", { name: "Menu" });

  await menuRegion.getByRole("tab", { name: combo.categoryName }).click();
  await menuRegion.getByRole("button", { name: new RegExp(combo.name) }).click();

  const picker = page.getByRole("form", { name: `Add ${combo.name}` });

  // One choice per course is preselected; the burger inside still needs its temperature.
  await expect(picker.getByLabel(menu.burger.name)).toBeChecked();
  await expect(picker.getByText("+$0.50")).toBeVisible();
  await picker.getByLabel("Medium").check();
  await picker.getByRole("button", { name: "Add to order" }).click();

  await expect(page.getByRole("listitem", { name: `Unsent ${combo.name}` })).toContainText("$10.50");
  await expect(page.getByRole("listitem", { name: `Unsent ${menu.burger.name}` })).toContainText(`Part of Main · ${combo.name}`);
  await expect(page.getByRole("listitem", { name: `Unsent ${menu.soda.name}` })).toContainText("$0.00");

  await page.getByRole("button", { name: /^Send 3 items$/ }).click();
  await expect(page.getByRole("listitem", { name: `Sent ${combo.name}` })).toContainText("Sent in round 1");
  await expect(page.getByRole("listitem", { name: `Sent ${menu.burger.name}` })).toContainText(`Part of Main · ${combo.name}`);
  await expect(page.getByLabel("Order total")).toHaveText("$10.50");
});
