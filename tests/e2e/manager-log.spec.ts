import { expect, test, type Browser, type Page } from "@playwright/test";

import { createBriefingsSetup, disableBriefingsAccounts, type BriefingsSetup } from "../helpers/e2e-briefings";
import type { OrdersAccount } from "../helpers/e2e-orders";
import { expandNavGroups, signInWithRetry } from "../helpers/e2e-ui";

// Phase 32: a manager logs an entry and corrects it; the owner redacts one with a reason. A
// manager writes a pre-shift note for servers; a server sees it on the dashboard and the
// pre-shift page, a cook doesn't, and the server can't open the manager log.

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "America/Detroit" });

let setup: BriefingsSetup;

async function signedIn(browser: Browser, account: OrdersAccount): Promise<Page> {
  const page = await (await browser.newContext({ timezoneId: "America/Detroit" })).newPage();

  await signInWithRetry(page, account);
  expect((await page.request.put("/api/session/location", { data: { locationId: setup.locationId } })).ok()).toBe(true);

  return page;
}

test.beforeAll(async () => {
  setup = await createBriefingsSetup();
});

test.afterAll(async () => {
  await disableBriefingsAccounts();
});

test("a log entry is added, corrected and redacted, and never rewritten", async ({ browser }) => {
  test.setTimeout(120_000);

  const manager = await signedIn(browser, setup.manager);

  // The Manager log is in the Service group.
  await manager.goto("/dashboard");
  await expandNavGroups(manager);
  await manager.getByRole("link", { name: "Manager log" }).click();
  await expect(manager.getByRole("heading", { name: "Manager log" })).toBeVisible();

  const addForm = manager.getByRole("form", { name: "Add an entry" });

  await addForm.getByLabel("Category").selectOption("MAINTENANCE");
  await addForm.getByLabel("Entry").fill(`Fryer 2 down at 7 PM (${setup.suffix})`);
  await addForm.getByRole("button", { name: "Add entry" }).click();

  const original = manager.getByTestId("log-entry").filter({ hasText: `Fryer 2 down at 7 PM (${setup.suffix})` });

  await expect(original).toBeVisible();

  const number = (await original.textContent())!.match(/LOG-\d{6}/)![0];

  // A correction is a new entry; the original stays and is marked.
  await original.getByRole("button", { name: "Correct" }).click();

  const correctForm = manager.getByRole("form", { name: "Correct an entry" });

  await expect(correctForm.getByRole("heading", { name: `Correct ${number}` })).toBeVisible();
  await correctForm.getByLabel("Entry").fill(`Correction: it was fryer 1 (${setup.suffix})`);
  await correctForm.getByRole("button", { name: "Add correction" }).click();

  await expect(original.getByText(/Corrected by LOG-\d{6}/)).toBeVisible();
  await expect(original.getByText(`Fryer 2 down at 7 PM (${setup.suffix})`)).toBeVisible();
  await expect(manager.getByTestId("log-entry").filter({ hasText: `Corrects ${number}` })).toBeVisible();

  // A manager can't redact.
  await expect(original.getByRole("button", { name: "Redact" })).toHaveCount(0);

  // The owner redacts the original with a reason; its number and mark stay.
  const owner = await signedIn(browser, setup.owner);

  await owner.goto("/manager-log");

  const ownerView = owner.getByTestId("log-entry").filter({ hasText: number }).filter({ hasText: "Corrected by" });

  await ownerView.getByRole("button", { name: "Redact" }).click();

  const dialog = owner.getByRole("dialog", { name: `Redact ${number}?` });

  await dialog.getByLabel("Reason").fill("Written at the wrong location");
  await dialog.getByRole("button", { name: "Redact entry" }).click();

  await expect(ownerView.getByText("Redacted", { exact: true })).toBeVisible();
  await expect(ownerView.getByText(/Reason: Written at the wrong location/)).toBeVisible();
  await expect(owner.getByText(`Fryer 2 down at 7 PM (${setup.suffix})`)).toHaveCount(0);
});

test("a note for servers reaches a server, not a cook, and staff can't open the log", async ({ browser }) => {
  test.setTimeout(120_000);

  const manager = await signedIn(browser, setup.manager);

  await manager.goto("/pre-shift");
  await manager.getByRole("link", { name: "Manage notes" }).click();

  const form = manager.getByRole("form", { name: "Write a note" });

  await form.getByLabel("Title").fill(`Specials ${setup.suffix}`);
  await form.getByLabel("Note").fill("Halibut special; the rosé is 86.");
  await form.getByLabel("Server", { exact: true }).check();
  await form.getByRole("button", { name: "Add note" }).click();

  await expect(manager.getByTestId("managed-note").filter({ hasText: `Specials ${setup.suffix}` })).toBeVisible();

  const server = await signedIn(browser, setup.server);

  await server.goto("/dashboard");
  await expect(
    server.getByRole("region", { name: "Pre-shift notes today" }).getByTestId("pre-shift-note").filter({ hasText: `Specials ${setup.suffix}` }),
  ).toBeVisible();
  await server.goto("/pre-shift");
  await expect(server.getByTestId("pre-shift-note").filter({ hasText: `Specials ${setup.suffix}` })).toBeVisible();

  await server.goto("/manager-log");
  await expect(server).toHaveURL(/\/access-denied/);

  const cook = await signedIn(browser, setup.cook);

  await cook.goto("/pre-shift");
  await expect(cook.getByRole("heading", { name: "Pre-shift" })).toBeVisible();
  await expect(cook.getByText(`Specials ${setup.suffix}`)).toHaveCount(0);
});
