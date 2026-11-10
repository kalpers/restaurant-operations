import { expect, type Page } from "@playwright/test";

// Phase 15 UI conventions shared by the end-to-end specs.

export const mainNavigation = (page: Page) => page.getByRole("navigation", { name: "Main" });

/**
 * Follows a main-navigation link. Below the `lg` breakpoint the navigation lives in a
 * drawer, so the Menu button opens it first.
 */
export async function openNavLink(page: Page, name: string) {
  const menu = page.getByRole("button", { name: "Menu", exact: true });

  if (await menu.isVisible()) {
    await menu.click();
  }

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
