import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  createRoleAccount,
  createRsvTable,
  guestName,
  removeReservationE2eData,
  type ReservationAccount,
} from "../helpers/e2e-reservations";
import { signInWithRetry } from "../helpers/e2e-ui";

// Phase 27 (policy 4): the floor and the waitlist update on another device without a reload.
// Every wait is well inside the boards' 30-second fallback refresh, so a pass is the
// realtime event, not the timer.

const LIVE_WAIT = { timeout: 15_000 };

const tableCard = (page: Page, tableNumber: string) =>
  page.getByRole("listitem", { name: `Table ${tableNumber}`, exact: true });
const waitlistCard = (page: Page, name: string) =>
  page.getByRole("listitem", { name: `Waitlist entry for ${name}`, exact: true });

async function signedIn(browser: Browser, account: ReservationAccount, path: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();

  await signInWithRetry(page, account);
  await page.goto(path);
  // The stream must be open before the other device acts.
  await expect(page.getByTestId("connection-status")).toHaveText("Live", LIVE_WAIT);

  return page;
}

test.afterAll(async () => {
  await removeReservationE2eData();
});

test("the floor shows a seating, a completed session and a cleaned table from another device", async ({
  browser,
}) => {
  test.setTimeout(90_000);

  const owner = await createRoleAccount("OWNER");
  const host = await createRoleAccount("HOST");
  const table = await createRsvTable(owner, { capacity: 4 });
  const watcher = await signedIn(browser, host, "/restaurant/floor");
  const actor = await signedIn(browser, host, "/restaurant/floor");

  await expect(tableCard(watcher, table.tableNumber)).toContainText("Available");

  await tableCard(actor, table.tableNumber)
    .getByRole("checkbox", { name: `Select ${table.tableNumber}` })
    .check();

  const form = actor.getByRole("form", { name: "Seat a party" });

  await form.getByLabel("Party size").fill("2");
  await form.getByRole("button", { name: "Seat party" }).click();
  await expect(tableCard(actor, table.tableNumber)).toContainText("Occupied");
  await expect(tableCard(watcher, table.tableNumber)).toContainText("Occupied", LIVE_WAIT);

  await tableCard(actor, table.tableNumber).getByRole("button", { name: "Complete session" }).click();
  await expect(tableCard(watcher, table.tableNumber)).toContainText("Dirty", LIVE_WAIT);

  await tableCard(actor, table.tableNumber).getByRole("button", { name: "Mark clean" }).click();
  await expect(tableCard(watcher, table.tableNumber)).toContainText("Available", LIVE_WAIT);
});

test("the waitlist shows a new walk-in and a party leaving from another device", async ({ browser }) => {
  test.setTimeout(90_000);

  const host = await createRoleAccount("HOST");
  const name = guestName("Live");
  const watcher = await signedIn(browser, host, "/host/waitlist");
  const actor = await signedIn(browser, host, "/host/waitlist");
  const form = actor.getByRole("form", { name: "Add walk-in" });

  await form.getByLabel("Guest name").fill(name);
  await form.getByLabel("Party size").fill("2");
  await form.getByRole("button", { name: "Add to waitlist" }).click();
  await expect(waitlistCard(actor, name)).toContainText("Waiting");
  await expect(waitlistCard(watcher, name)).toContainText("Waiting", LIVE_WAIT);

  await waitlistCard(actor, name).getByRole("button", { name: "Left" }).click();
  await expect(waitlistCard(watcher, name)).toHaveCount(0, LIVE_WAIT);
});
