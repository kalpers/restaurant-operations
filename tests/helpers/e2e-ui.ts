import { expect, type Locator, type Page } from "@playwright/test";

// Phase 15 UI conventions shared by the end-to-end specs.

export const mainNavigation = (page: Page) => page.getByRole("navigation", { name: "Main" });

/**
 * Opens every collapsed group in the main navigation so any permitted link can be reached.
 * Below the `lg` breakpoint the navigation lives in a drawer, so the Menu button opens it first.
 */
export async function expandNavGroups(page: Page) {
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  const nav = mainNavigation(page);

  if ((await menu.isVisible()) && (await menu.getAttribute("aria-expanded")) !== "true") {
    await menu.click();
  }

  const collapsed = nav.locator('button[aria-expanded="false"]');

  // Each click re-renders the list, so always take the first one still collapsed.
  // The bound keeps a click lost before hydration (under `next dev`) from looping forever.
  for (let attempt = 0; attempt < 20 && (await collapsed.count()) > 0; attempt += 1) {
    await collapsed.first().click();
  }
}

/** Follows a main-navigation link, opening its group first. */
export async function openNavLink(page: Page, name: string) {
  await expandNavGroups(page);
  await mainNavigation(page).getByRole("link", { name, exact: true }).click();
}

/** Clicks the go-ahead button in the open confirmation dialog. */
export async function confirmDialog(page: Page, confirmLabel: string) {
  const dialog = page.getByRole("dialog");

  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: confirmLabel, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

/** A success message shown as a toast. */
export async function expectToast(page: Page, text: string) {
  await expect(page.getByTestId("toast-region")).toContainText(text);
}

/**
 * Phase 25 policy 16: clicks until `shown` passes. Under `next dev` a click that lands before
 * hydration is lost, so a later attempt checks for the result first and clicks again only if
 * it isn't there. Use only where clicking twice is harmless. `shown` should wait briefly
 * (for example `{ timeout: 5_000 }`).
 */
export async function clickUntilShown(target: Locator, shown: () => Promise<void>, timeout = 60_000) {
  let attempted = false;

  await expect(async () => {
    if (attempted) {
      try {
        await shown();

        return;
      } catch {
        // Not there yet: click again.
      }
    }

    attempted = true;
    await target.click({ timeout: 5_000 });
    await shown();
  }).toPass({ timeout });
}

/**
 * Signs in through the login page and waits for the dashboard. Under `next dev` the first
 * request after a recompile can fail outright (ECONNRESET) or land before the form is
 * interactive, so the whole sign-in is retried until the dashboard shows. If an earlier
 * attempt did sign in but its response was lost, the login page sends the user on to the
 * dashboard and the retry stops there. For sign-ins that are expected to succeed; a test
 * of a failed sign-in must drive the form itself.
 */
export async function signInWithRetry(page: Page, account: { email: string; password: string }, timeout = 60_000) {
  await expect(async () => {
    await page.goto("/login");

    if (new URL(page.url()).pathname === "/dashboard") {
      return;
    }

    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 10_000 });
  }).toPass({ timeout });
}
