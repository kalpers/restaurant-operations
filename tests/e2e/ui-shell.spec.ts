import { expect, test, type Page } from "@playwright/test";

import { confirmDialog, expectToast, mainNavigation } from "../helpers/e2e-ui";
import {
  createOrderMenu,
  createRoleAccount,
  removeOrdersE2eData,
  sentOrderFor,
  takeoutWithDraft,
  SHELL_SCOPE,
  type OrdersAccount,
} from "../helpers/e2e-orders";

// Phase 15: the app shell (grouped navigation, phone drawer), confirmations, toasts,
// route-level not-found, and the order workspace's menu search.

async function signIn(page: Page, account: OrdersAccount) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

function hasHorizontalScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}

test.afterAll(async () => {
  await removeOrdersE2eData(SHELL_SCOPE);
});

test.describe("app shell", () => {
  test("navigation is grouped by area, shows only permitted links, and marks the current page", async ({ page }) => {
    const server = await createRoleAccount("SERVER", SHELL_SCOPE);

    await signIn(page, server);

    const nav = mainNavigation(page);

    await expect(nav.getByText("Service", { exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Orders", exact: true })).toBeVisible();
    // A server holds no administration or audit permission, so those groups don't appear.
    await expect(nav.getByText("Admin", { exact: true })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Audit" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");

    await nav.getByRole("link", { name: "Orders", exact: true }).click();
    await expect(page).toHaveURL(/\/orders$/);
    await expect(nav.getByRole("link", { name: "Orders", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current", "page");
  });

  test("an owner sees every group", async ({ page }) => {
    await signIn(page, await createRoleAccount("OWNER", SHELL_SCOPE));

    const nav = mainNavigation(page);

    for (const group of ["Insights", "Service", "Back of house", "People", "Admin"]) {
      await expect(nav.getByText(group, { exact: true })).toBeVisible();
    }
  });

  test("at phone width the navigation opens as a drawer and closes after navigating", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await signIn(page, await createRoleAccount("MANAGER", SHELL_SCOPE));

    const menu = page.getByRole("button", { name: "Menu", exact: true });
    const nav = mainNavigation(page);

    await expect(nav.getByRole("link", { name: "Floor", exact: true })).toBeHidden();
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(nav.getByRole("link", { name: "Floor", exact: true })).toBeVisible();

    // Escape closes it and returns focus to the Menu button.
    await page.keyboard.press("Escape");
    await expect(nav.getByRole("link", { name: "Floor", exact: true })).toBeHidden();
    await expect(menu).toBeFocused();

    await menu.click();
    await nav.getByRole("link", { name: "Floor", exact: true }).click();
    await expect(page).toHaveURL(/\/restaurant\/floor$/);
    await expect(nav.getByRole("link", { name: "Floor", exact: true })).toBeHidden();
    expect(await hasHorizontalScroll(page)).toBe(false);

    for (const path of ["/orders", "/my-schedule", "/dashboard"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      expect(await hasHorizontalScroll(page), `${path} scrolls sideways`).toBe(false);
    }
  });

  test("an unknown record shows the not-found page", async ({ page }) => {
    await signIn(page, await createRoleAccount("MANAGER", SHELL_SCOPE));
    await page.goto("/orders/00000000-0000-4000-8000-000000000000");
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to the dashboard" })).toBeVisible();
  });
});

test.describe("confirmations and feedback", () => {
  test("a destructive action asks first; backing out changes nothing", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER", SHELL_SCOPE);
    const owner = await createRoleAccount("OWNER", SHELL_SCOPE);

    await signIn(page, owner);
    await page.goto("/admin/users");

    const row = page.getByRole("listitem").filter({ hasText: manager.email });

    await row.getByRole("button", { name: "Disable" }).click();

    const dialog = page.getByRole("dialog");

    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
    await dialog.getByRole("button", { name: "Keep it" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Disable" })).toBeVisible();

    await row.getByRole("button", { name: "Disable" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Disable" })).toBeVisible();

    await row.getByRole("button", { name: "Disable" }).click();
    await confirmDialog(page, "Disable user");
    await expectToast(page, "Done.");
    await expect(row.getByRole("button", { name: "Enable" })).toBeVisible();
  });
});

test.describe("order workspace", () => {
  test("the menu search filters what is on screen, and / focuses it", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER", SHELL_SCOPE);
    const menu = await createOrderMenu(manager);
    const { orderId } = await takeoutWithDraft(manager, menu.soda.id);

    await signIn(page, manager);
    await page.goto(`/orders/${orderId}`);

    const unsent = page.getByRole("region", { name: "Unsent items" });

    await expect(unsent).toContainText("1 not sent");

    const search = page.getByRole("searchbox", { name: "Search the menu" });

    // The shortcut works once the page has hydrated, so retry until it takes.
    await expect(async () => {
      await page.locator("body").press("/");
      await expect(search).toBeFocused({ timeout: 500 });
    }).toPass({ timeout: 15_000 });
    await search.fill(menu.burger.name.slice(-8));

    const menuRegion = page.getByRole("region", { name: "Menu" });

    await expect(menuRegion.getByRole("button", { name: new RegExp(menu.burger.name) })).toBeVisible();
    await expect(menuRegion.getByRole("button", { name: new RegExp(menu.soda.name) })).toHaveCount(0);
    await expect(menuRegion.getByRole("tablist")).toHaveCount(0);

    await search.fill("no such dish anywhere");
    await expect(menuRegion).toContainText("Nothing matches");

    await search.fill("");
    await expect(menuRegion.getByRole("tablist")).toBeVisible();

    await page.getByRole("button", { name: "Send 1 item" }).click();
    await expectToast(page, "Sent 1 item.");
    await expect(unsent).not.toContainText("not sent");
  });

  test("a sent order still opens after the change to dialogs", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER", SHELL_SCOPE);
    const menu = await createOrderMenu(manager);
    const { orderId } = await sentOrderFor(manager, [menu.soda.id]);

    await signIn(page, manager);
    await page.goto(`/orders/${orderId}`);
    await page.getByRole("button", { name: "Void whole order" }).click();
    await expect(page.getByRole("dialog").getByRole("form", { name: "Void whole order" })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Keep order" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
