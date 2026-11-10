import { expect, test, type Browser, type Page } from "@playwright/test";

import { createAccount, generatePassword, removeE2eAccounts, type E2eAccount } from "../helpers/e2e-accounts";
import { confirmDialog, openNavLink } from "../helpers/e2e-ui";

// Phase 16 hardening: password change, administrator reset and forced change, sign-in
// lockout and unlock, and the System health page.

async function signIn(page: Page, account: Pick<E2eAccount, "email" | "password">) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function signInAndWait(page: Page, account: Pick<E2eAccount, "email" | "password">) {
  await signIn(page, account);
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function changePassword(page: Page, current: string, next: string) {
  await page.getByLabel("Current password").fill(current);
  await page.getByLabel(/^New password/).fill(next);
  await page.getByLabel("Confirm new password").fill(next);
  await page.getByRole("button", { name: "Change password" }).click();
}

/** The Users page card for one account. */
const userCard = (page: Page, email: string) =>
  page.locator("li").filter({ has: page.getByText(email, { exact: true }) }).first();

async function asOwner(browser: Browser) {
  const owner = await createAccount("OWNER");
  const context = await browser.newContext();
  const page = await context.newPage();

  await signInAndWait(page, owner);

  return { owner, page, close: () => context.close() };
}

test.afterAll(async () => {
  await removeE2eAccounts();
});

test("a user changes their password from the user menu; the new one works and the old one fails", async ({ page }) => {
  const server = await createAccount("SERVER");
  const newPassword = generatePassword();

  await signInAndWait(page, server);
  await page.getByRole("link", { name: "Change password" }).click();
  await expect(page).toHaveURL(/\/account\/password$/);
  await expect(page.getByRole("heading", { name: "Change password" })).toBeVisible();

  await changePassword(page, server.password, newPassword);
  await expect(page).toHaveURL(/\/dashboard$/);
  // The fresh session issued with the change still works.
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await signIn(page, server);
  await expect(page.getByText("Invalid email or password")).toBeVisible();

  await signInAndWait(page, { email: server.email, password: newPassword });
});

test("a changed password ends the user's other sessions", async ({ browser }) => {
  const server = await createAccount("SERVER");
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await signInAndWait(otherPage, server);
    await signInAndWait(page, server);

    await page.goto("/account/password");
    await changePassword(page, server.password, generatePassword());
    await expect(page).toHaveURL(/\/dashboard$/);

    await otherPage.goto("/dashboard");
    await expect(otherPage).toHaveURL(/\/login$/);
    expect((await otherPage.request.get("/api/notifications")).status()).toBe(401);
  } finally {
    await other.close();
    await context.close();
  }
});

test("an administrator resets a server's password; the server must change it, then reaches the Floor", async ({ browser, page }) => {
  const server = await createAccount("SERVER");
  const admin = await asOwner(browser);
  let temporaryPassword = "";

  try {
    await admin.page.goto("/admin/users");
    await userCard(admin.page, server.email).getByRole("button", { name: "Reset password" }).click();

    // Not confirmDialog(): confirming replaces the dialog with the one-time password dialog,
    // so a dialog stays open.
    const confirm = admin.page.getByRole("dialog", { name: "Reset this user's password?" });

    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Reset password", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(admin.page.getByRole("dialog", { name: "Temporary password" })).toBeVisible();

    const shown = admin.page.getByTestId("temporary-password");

    await expect(shown).toHaveText(/^[A-Za-z0-9_-]{16}$/);
    temporaryPassword = (await shown.textContent()) ?? "";
    await admin.page.getByRole("button", { name: "Done" }).click();
    await expect(admin.page.getByTestId("temporary-password")).toHaveCount(0);
    await expect(userCard(admin.page, server.email).getByText("Must change password")).toBeVisible();
  } finally {
    await admin.close();
  }

  await signIn(page, { email: server.email, password: temporaryPassword });
  await expect(page).toHaveURL(/\/account\/password$/);
  await expect(page.getByText("Your password was reset by an administrator.")).toBeVisible();

  // Every other page and API sends them back.
  await page.goto("/restaurant/floor");
  await expect(page).toHaveURL(/\/account\/password$/);

  const refused = await page.request.get("/api/notifications");

  expect(refused.status()).toBe(403);
  expect((await refused.json()).error.code).toBe("PASSWORD_CHANGE_REQUIRED");

  await changePassword(page, temporaryPassword, generatePassword());
  await expect(page).toHaveURL(/\/dashboard$/);
  await openNavLink(page, "Floor");
  await expect(page.getByRole("heading", { name: "Floor", exact: true })).toBeVisible();
});

test("five wrong passwords lock the account with the same error; the Users page shows it and Unlock clears it", async ({ browser, page }) => {
  const server = await createAccount("SERVER");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await signIn(page, { email: server.email, password: generatePassword() });
    await expect(page.getByText("Invalid email or password")).toBeVisible();
  }

  // Locked: even the correct password gets the identical message.
  await signIn(page, server);
  await expect(page.getByText("Invalid email or password")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  const admin = await asOwner(browser);

  try {
    await admin.page.goto("/admin/users");

    const card = userCard(admin.page, server.email);

    await expect(card.getByTestId("user-locked")).toContainText("Locked until");
    await card.getByRole("button", { name: "Unlock" }).click();
    await confirmDialog(admin.page, "Unlock");
    await expect(userCard(admin.page, server.email).getByTestId("user-locked")).toHaveCount(0);
  } finally {
    await admin.close();
  }

  await signInAndWait(page, server);
});

test("System health loads for an Owner and is denied to a Server", async ({ browser, page }) => {
  const admin = await asOwner(browser);

  try {
    await openNavLink(admin.page, "System health");
    await expect(admin.page.getByRole("heading", { name: "System health" })).toBeVisible();
    await expect(admin.page.getByTestId("outbox-dead")).toBeVisible();
    await expect(admin.page.getByTestId("outbox-unpublished")).toBeVisible();

    const health = await admin.page.request.get("/api/admin/system/health");

    expect(health.status()).toBe(200);
    expect(JSON.stringify(await health.json())).not.toContain("payload");
  } finally {
    await admin.close();
  }

  const server = await createAccount("SERVER");

  await signInAndWait(page, server);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "System health" })).toHaveCount(0);
  await page.goto("/admin/system");
  await expect(page).toHaveURL(/\/access-denied$/);
  expect((await page.request.get("/api/admin/system/health")).status()).toBe(403);
});
