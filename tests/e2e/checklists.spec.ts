import { expect, test, type Browser, type Page } from "@playwright/test";

import { createBriefingsSetup, disableBriefingsAccounts, type BriefingsSetup } from "../helpers/e2e-briefings";
import type { E2eScope, OrdersAccount } from "../helpers/e2e-orders";
import { expandNavGroups, signInWithRetry } from "../helpers/e2e-ui";

// Phase 36 part 1: a manager sets up server side work that needs signing off; a server works
// through their own list on their phone and completes it; another manager signs it off; the
// history shows it. A cook doesn't see the servers' list.

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "America/Detroit" });

const SCOPE: E2eScope = { emailDomain: "checklists-e2e.example.test", rolePrefix: "CHECKLISTS_E2E_", tablePrefix: "CHK-" };

let setup: BriefingsSetup;

async function signedIn(browser: Browser, account: OrdersAccount, mobile = false): Promise<Page> {
  const context = await browser.newContext({
    timezoneId: "America/Detroit",
    ...(mobile ? { viewport: { width: 390, height: 844 } } : {}),
  });
  const page = await context.newPage();

  await signInWithRetry(page, account);
  expect((await page.request.put("/api/session/location", { data: { locationId: setup.locationId } })).ok()).toBe(true);

  return page;
}

test.beforeAll(async () => {
  setup = await createBriefingsSetup(SCOPE);
});

test.afterAll(async () => {
  await disableBriefingsAccounts(SCOPE);
});

test("a server completes their side work and a manager signs it off", async ({ browser }) => {
  test.setTimeout(120_000);

  const name = `Server side work ${setup.suffix}`;
  const manager = await signedIn(browser, setup.manager);

  // Checklists are in the Service group.
  await manager.goto("/dashboard");
  await expandNavGroups(manager);
  await manager.getByRole("link", { name: "Checklists" }).click();
  await expect(manager.getByRole("heading", { name: "Checklists", exact: true })).toBeVisible();
  await manager.getByRole("link", { name: "Set up checklists" }).click();

  const form = manager.getByRole("form", { name: "New checklist" });

  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Kind").selectOption("SIDE_WORK");
  await form.getByRole("textbox", { name: "Item 1", exact: true }).fill("Roll silverware");
  await form.getByRole("button", { name: "Add item" }).click();
  await form.getByRole("textbox", { name: "Item 2", exact: true }).fill("Restock to-go boxes");
  await form.getByRole("button", { name: "Add item" }).click();
  await form.getByRole("textbox", { name: "Item 3", exact: true }).fill("Wipe high chairs");
  await form.getByLabel("Required").nth(2).uncheck();
  await form.getByLabel("Server", { exact: true }).check();
  await form.getByLabel("A manager signs it off after it's completed").check();
  await form.getByRole("button", { name: "Add checklist" }).click();

  await expect(manager.getByTestId("checklist-template").filter({ hasText: name })).toBeVisible();

  // The server sees it on the dashboard and works through it on a phone-sized screen.
  const server = await signedIn(browser, setup.server, true);

  await server.goto("/dashboard");
  await expect(server.getByRole("region", { name: "Today's checklists" }).getByText(name)).toBeVisible();
  await server.goto("/checklists");

  const entry = server.getByTestId("checklist-today").filter({ hasText: name });

  await entry.getByRole("button", { name: "Start" }).click();
  await expect(server.getByRole("heading", { name })).toBeVisible();

  await server.getByRole("checkbox", { name: "Roll silverware" }).click();
  await expect(server.getByRole("checkbox", { name: "Roll silverware" })).toHaveAttribute("aria-checked", "true");

  // Completing is blocked while a required item is open.
  await expect(server.getByRole("button", { name: "Complete checklist" })).toBeDisabled();
  await expect(server.getByText("1 required item is still open.")).toBeVisible();

  // Skip the optional item with a reason, tick the last required one, add a note.
  const highChairs = server.getByTestId("checklist-item").filter({ hasText: "Wipe high chairs" });

  await highChairs.getByRole("button", { name: "Skip" }).click();

  const skip = server.getByRole("dialog", { name: 'Skip "Wipe high chairs"?' });

  await skip.getByLabel("Why is it skipped?").fill("None used tonight");
  await skip.getByRole("button", { name: "Skip item" }).click();
  await expect(highChairs.getByText(/Skipped by .*: None used tonight/)).toBeVisible();

  await server.getByRole("checkbox", { name: "Restock to-go boxes" }).click();
  await server.getByTestId("checklist-item").filter({ hasText: "Restock to-go boxes" }).getByRole("button", { name: "Add note" }).click();

  const note = server.getByRole("dialog", { name: 'Note on "Restock to-go boxes"' });

  await note.getByLabel("Note").fill("Low on large lids");
  await note.getByRole("button", { name: "Save note" }).click();
  await expect(server.getByText("Note: Low on large lids")).toBeVisible();

  await server.getByRole("button", { name: "Complete checklist" }).click();
  await expect(server.getByText("Awaiting sign-off")).toBeVisible();
  await expect(server.getByRole("checkbox", { name: "Roll silverware" })).toBeDisabled();

  // A cook doesn't see the servers' list.
  const cook = await signedIn(browser, setup.cook);

  await cook.goto("/checklists");
  await expect(cook.getByText(name)).toHaveCount(0);

  // The owner (a manager who didn't complete it) signs it off; it shows in the history.
  const owner = await signedIn(browser, setup.owner);

  await owner.goto("/checklists");
  await owner.getByRole("region", { name: "Everyone's side work today" }).getByRole("link", { name: new RegExp(name) }).click();
  await owner.getByRole("button", { name: "Sign off" }).click();
  await expect(owner.getByText("Signed off", { exact: true })).toBeVisible();

  await owner.goto("/checklists/history");
  await expect(owner.getByRole("row").filter({ hasText: name }).getByText("Signed off")).toBeVisible();
});
