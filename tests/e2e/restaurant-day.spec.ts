import { readFile } from "node:fs/promises";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { confirmDialog } from "../helpers/e2e-ui";

import {
  createDayMenu,
  createDayTable,
  createDraftSchedule,
  dayAccount,
  disableDayAccounts,
  onHand,
  orderNumberOf,
  periodStatus,
} from "../helpers/e2e-day";
import { findMainLocationId } from "../helpers/e2e-accounts";
import type { OrdersAccount } from "../helpers/e2e-orders";
import { createWorker, ensureServerTipPool } from "../helpers/e2e-timeclock";

// Phase 13: the canonical restaurant day (README section 38) through the screens, one
// browser per role. Setup (accounts, menu, a table, a draft schedule) uses the services;
// every operational step after that is done on screen. Assertions name this spec's own
// menu item, table and accounts, because other specs use MAIN on a parallel worker.

test.describe.configure({ mode: "serial" });

async function signedIn(browser: Browser, account: OrdersAccount): Promise<Page> {
  const page = await (await browser.newContext()).newPage();

  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  return page;
}

async function addItem(page: Page, categoryName: string, itemName: string, modifiers: string[] = []) {
  const menu = page.getByRole("region", { name: "Menu" });

  await menu.getByRole("tab", { name: categoryName }).click();
  await menu.getByRole("button", { name: new RegExp(itemName) }).click();

  const picker = page.getByRole("form", { name: `Add ${itemName}` });

  for (const modifier of modifiers) {
    // A priced modifier's label also shows its price ("Extra Pickles +$0.50"), so match a
    // substring. No modifier name here is part of another.
    await picker.getByLabel(modifier).check();
  }

  await picker.getByRole("button", { name: "Add to order" }).click();
  await expect(page.getByRole("listitem", { name: `Unsent ${itemName}` })).toBeVisible();
}

const ticketCard = (page: Page, orderNumber: number) =>
  page.locator(`[data-testid="active-queue"] [data-testid="ticket-card"][data-order-number="${orderNumber}"]`);

/** Start, Ready, Bump on the one card this order has at the station. */
async function runTicket(page: Page, orderNumber: number, itemName: string) {
  const card = ticketCard(page, orderNumber);

  await expect(card).toHaveCount(1, { timeout: 15_000 });
  await expect(card).toContainText(itemName);
  await card.getByRole("button", { name: "Start" }).click();
  await expect(card.getByRole("button", { name: "Ready" })).toBeVisible();
  await card.getByRole("button", { name: "Ready" }).click();
  await expect(card.getByRole("button", { name: "Bump" })).toBeVisible();
  await card.getByRole("button", { name: "Bump" }).click();
  await expect(card).toHaveCount(0);
}

test.afterAll(async () => {
  await disableDayAccounts();
});

test("a full restaurant day: schedule, reservation, seating, order, kitchen, settlement, table, reports, audit", async ({
  browser,
}) => {
  test.setTimeout(240_000);

  const owner = await dayAccount("OWNER");
  const manager = await dayAccount("MANAGER");
  const host = await dayAccount("HOST");
  const server = await dayAccount("SERVER");
  const cook = await dayAccount("COOK");
  const bartender = await dayAccount("BARTENDER");
  const menu = await createDayMenu(owner);
  const table = await createDayTable(owner);
  const { periodId } = await createDraftSchedule(owner);
  const guest = `Day Garcia ${Date.now()}`;
  // Phase 18: the server's login is linked to an employee who works as a Server at MAIN, and
  // MAIN pools tips by Server hours.
  const mainLocationId = await findMainLocationId();
  const serverWorker = await createWorker({ locationId: mainLocationId, userId: server.id, firstName: "Sam" });

  await ensureServerTipPool(mainLocationId);

  // 1. The manager publishes the schedule.
  const managerPage = await signedIn(browser, manager);

  await managerPage.goto(`/scheduling/${periodId}`);
  await managerPage.getByRole("button", { name: "Publish" }).click();
  await confirmDialog(managerPage, "Publish");
  await expect(managerPage.getByTestId("period-status")).toHaveText("Published");
  expect(await periodStatus(periodId)).toBe("PUBLISHED");

  // 2. The host takes a pending reservation, confirms it, checks the party in and seats it.
  const hostPage = await signedIn(browser, host);

  await hostPage.goto("/host/reservations");
  await hostPage.getByRole("button", { name: "New reservation" }).click();

  const form = hostPage.getByRole("form", { name: "New reservation" });
  const soon = new Date(Date.now() + 30 * 60_000);
  const local = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Detroit", ...options }).format(soon);

  await form.getByLabel("Guest name").fill(guest);
  await form.getByLabel("Party size").fill("4");
  await form.getByLabel("Date").fill(local({ year: "numeric", month: "2-digit", day: "2-digit" }));
  await form.getByLabel("Time").fill(local({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
  await form.getByLabel("Status").selectOption("PENDING");
  await form.getByRole("button", { name: "Create reservation" }).click();

  const reservation = hostPage.getByRole("listitem", { name: `Reservation for ${guest}`, exact: true });

  await expect(reservation).toContainText("Pending");
  await reservation.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(reservation).toContainText("Confirmed");
  await reservation.getByRole("button", { name: "Check in" }).click();
  await expect(reservation).toContainText("Checked in");
  await reservation.getByRole("button", { name: "Seat", exact: true }).click();

  const seatForm = hostPage.getByRole("form", { name: "Seat reservation" });

  await seatForm.getByRole("checkbox", { name: table.tableNumber, exact: true }).check();
  await seatForm.getByRole("button", { name: "Seat party" }).click();
  await expect(reservation).toContainText(`Seated at ${table.tableNumber}`);

  // 3. The server clocks in (Phase 18), then opens the order: drinks, then the appetizer,
  // then the canonical burger.
  const serverPage = await signedIn(browser, server);

  await serverPage.goto("/my-time");
  await serverPage.getByRole("button", { name: "Clock in" }).click();
  await expect(serverPage.getByRole("region", { name: "Time clock" })).toContainText("On the clock");

  await serverPage.goto("/restaurant/floor");
  await serverPage.getByRole("listitem", { name: `Table ${table.tableNumber}` }).getByRole("link", { name: "Orders" }).click();
  await serverPage.getByRole("button", { name: "New dine-in order" }).click();
  await expect(serverPage).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);

  const orderId = serverPage.url().split("/").at(-1)!;
  const orderNumber = await orderNumberOf(orderId);
  const barPage = await signedIn(browser, bartender);
  const kitchenPage = await signedIn(browser, cook);

  await barPage.goto("/bar");
  await kitchenPage.goto("/kitchen");

  await addItem(serverPage, menu.categoryName, menu.margarita.name);
  await serverPage.getByRole("button", { name: "Send 1 item" }).click();
  await expect(serverPage.getByRole("listitem", { name: `Sent ${menu.margarita.name}` })).toContainText("Sent in round 1");

  // 4. The bar runs the drink as soon as it arrives.
  await runTicket(barPage, orderNumber, menu.margarita.name);

  await addItem(serverPage, menu.categoryName, menu.fries.name);
  await serverPage.getByRole("button", { name: "Send 1 item" }).click();
  await runTicket(kitchenPage, orderNumber, menu.fries.name);

  await addItem(serverPage, menu.categoryName, menu.burger.name, [
    "Medium",
    "No Onion",
    "Extra Pickles",
    "Swiss instead of American",
  ]);
  await expect(serverPage.getByRole("listitem", { name: `Unsent ${menu.burger.name}` })).toContainText("$17.49");
  // A draft consumes nothing.
  expect(await onHand(menu.stock.pickles.id)).toBe("50.0000");
  await serverPage.getByRole("button", { name: "Send 1 item" }).click();

  const sentBurger = serverPage.getByRole("listitem", { name: `Sent ${menu.burger.name}` });

  await expect(sentBurger).toContainText("Sent in round 3");
  await expect(serverPage.getByLabel("Order total")).toHaveText("$32.99");
  // Swiss replaced American, no onion, 3 + 2 pickles: consumed once, at SEND.
  expect(await onHand(menu.stock.pickles.id)).toBe("45.0000");
  expect(await onHand(menu.stock.swiss.id)).toBe("49.0000");
  expect(await onHand(menu.stock.american.id)).toBe("50.0000");
  expect(await onHand(menu.stock.onion.id)).toBe("50.0000");

  // The kitchen sees the modifiers on the ticket, then runs it.
  await expect(ticketCard(kitchenPage, orderNumber)).toContainText("Swiss instead of American", { timeout: 15_000 });
  await runTicket(kitchenPage, orderNumber, menu.burger.name);

  // 5. The server was told three times: drinks, then food twice.
  await serverPage.reload();
  await expect(serverPage.getByTestId("notification-count")).toHaveText("3", { timeout: 15_000 });
  await serverPage.getByTestId("notification-bell").click();
  await expect(serverPage.getByText(`Drinks ready: order #${orderNumber}`)).toBeVisible();
  await expect(serverPage.getByText(`Food ready: order #${orderNumber}`)).toHaveCount(2);
  await serverPage.keyboard.press("Escape");

  // 6a. Phase 17: the owner sets up a drawer and the manager opens it with a float. The
  // main location requires an open drawer for cash.
  const ownerPage = await signedIn(browser, owner);
  const drawerCode = `DAY_${Date.now().toString(36).toUpperCase()}`;
  const drawerName = `Day register ${drawerCode}`;

  await ownerPage.goto("/cash-drawers");

  const addDrawer = ownerPage.getByRole("region", { name: "Add a drawer" });

  await addDrawer.getByLabel("Code (capitals, digits, _)").fill(drawerCode);
  await addDrawer.getByLabel("Name").fill(drawerName);
  await addDrawer.getByRole("button", { name: "Add drawer" }).click();
  await expect(ownerPage.getByRole("listitem").filter({ hasText: drawerName })).toBeVisible();

  await managerPage.goto("/cash-drawers");

  const drawerRow = managerPage.getByRole("listitem").filter({ hasText: drawerName });

  await drawerRow.getByLabel("Starting float").fill("100.00");
  await drawerRow.getByRole("button", { name: `Open ${drawerName}` }).click();
  await expect(managerPage.getByRole("region", { name: `Open drawer ${drawerCode}` })).toBeVisible();

  // 6b. Settlement, recorded only: part cash into the drawer, the rest on an external card with a tip.
  await serverPage.goto(`/orders/${orderId}`);
  await serverPage.getByRole("link", { name: "Settle check" }).click();
  await serverPage.getByRole("button", { name: "Open settlement for $32.99" }).click();

  const tender = serverPage.getByRole("form", { name: "Record tender" });

  await tender.getByLabel("Amount applied to the order").fill("20.00");
  await tender.getByLabel("Cash received").fill("20.00");
  await tender.getByLabel("Cash drawer").selectOption({ label: `${drawerName} (${drawerCode} · session 1)` });
  await tender.getByRole("button", { name: "Record cash" }).click();
  await expect(serverPage.getByLabel("Remaining")).toHaveText("$12.99");
  await tender.getByLabel("Tender type").selectOption("EXTERNAL_CARD");
  await expect(tender.getByLabel("Amount applied to the order")).toHaveValue("12.99");
  await tender.getByLabel("Tip (separate from the order)").fill("5.00");
  await tender.getByLabel("Last four digits (optional)").fill("4242");
  await tender.getByRole("button", { name: "Record card (external terminal)" }).click();
  await expect(serverPage.getByLabel("Remaining")).toHaveText("$0.00");
  await serverPage.getByRole("button", { name: "Complete settlement and close order" }).click();
  await expect(serverPage.getByTestId("order-status")).toHaveText("Closed");

  // 6c. Phase 17: the manager records a partial refund on the closed check (record only).
  // The check stays closed; the refund counts on today's date.
  await managerPage.goto(`/orders/${orderId}/settlement`);

  const refund = managerPage.getByRole("form", { name: "Record refund" });

  await refund.getByLabel("Amount refunded (with tax)").fill("5.00");
  await refund.getByLabel("Reason").fill("Burger came out cold");
  await refund.getByRole("button", { name: "Record refund" }).click();
  await expect(managerPage.getByTestId("refund")).toContainText("Burger came out cold");
  await expect(managerPage.getByTestId("order-status")).toHaveText("Closed");

  // 6d. At close the manager counts the drawer: float 100.00 + 20.00 cash = 120.00, no variance.
  await managerPage.goto("/cash-drawers");

  const openDrawer = managerPage.getByRole("region", { name: `Open drawer ${drawerCode}` });

  await expect(openDrawer.getByLabel("Expected cash")).toHaveText("$120.00");
  await openDrawer.getByLabel("Cash counted").fill("120.00");
  await openDrawer.getByRole("button", { name: "Close drawer" }).click();
  await expect(managerPage.getByRole("region", { name: `Open drawer ${drawerCode}` })).toHaveCount(0);
  await expect(
    managerPage.getByRole("region", { name: "Closed drawers" }).getByRole("row").filter({ hasText: drawerCode }),
  ).toContainText("$0.00");

  // 7. Closing the check doesn't free the table: the guests leave, then it's cleaned.
  await hostPage.goto("/restaurant/floor");

  const tableCard = hostPage.getByRole("listitem", { name: `Table ${table.tableNumber}` });

  await expect(tableCard).toContainText("Occupied");
  await tableCard.getByRole("button", { name: "Complete session" }).click();
  await expect(tableCard).toContainText("Dirty");
  await tableCard.getByRole("button", { name: "Mark clean" }).click();
  await expect(tableCard).toContainText("Available");

  // 7b. Phase 18: the server clocks out; the manager sees the server's share in the day's tip
  // pool. Finalizing is covered by labor-tips.spec on its own location, because other specs
  // leave open checks on MAIN today.
  await serverPage.goto("/my-time");
  await serverPage.getByRole("button", { name: "Clock out" }).click();
  await expect(serverPage.getByRole("region", { name: "Time clock" })).toContainText("Off the clock");
  await expect(serverPage.getByRole("region", { name: "This week" })).toContainText("Server");

  await managerPage.goto("/tips");
  await expect(
    managerPage.getByRole("region", { name: "Distribute tips" }).getByRole("row").filter({ hasText: serverWorker.name }),
  ).toBeVisible();

  // 8. The owner's reports show the sale from its snapshots, and export it.
  await ownerPage.goto("/reports/menu");

  const items = ownerPage.getByRole("table", { name: "Menu items" });

  await expect(items).toBeVisible({ timeout: 20_000 });
  await expect(items.getByRole("row").filter({ hasText: menu.burger.code })).toContainText("$17.49");
  await expect(items.getByRole("row").filter({ hasText: menu.margarita.code })).toContainText("$11.00");

  const download = ownerPage.waitForEvent("download");

  await ownerPage.getByRole("link", { name: "Export Menu items as CSV" }).click();

  const csv = await readFile((await (await download).path())!, "utf8");

  expect(csv).toContain(`${menu.burger.code},${menu.burger.name},1,17.49`);

  // Phase 18: actual labor shows the server's clocked time next to the scheduled sections.
  await ownerPage.goto("/reports/labor");
  await expect(
    ownerPage.getByRole("table", { name: "Actual labor by employee" }).getByRole("row").filter({ hasText: serverWorker.employeeNumber }),
  ).toBeVisible({ timeout: 20_000 });

  // 9. The audit trail holds each SEND batch and the settlement, by this server. The viewer
  // names a login linked to an employee (Phase 18 links the server) by the employee name.
  await ownerPage.goto("/audit");
  await expect(ownerPage.getByRole("heading", { name: "Audit trail" })).toBeVisible({ timeout: 20_000 });
  await ownerPage.getByLabel("Action").selectOption("orders.items-sent");
  await ownerPage.getByRole("button", { name: "Filter" }).click();
  await expect(
    ownerPage.getByRole("row", { name: "Audit orders.items-sent" }).filter({ hasText: serverWorker.name }),
  ).toHaveCount(3);
  await ownerPage.getByLabel("Action").selectOption("settlements.completed");
  await ownerPage.getByRole("button", { name: "Filter" }).click();
  await expect(
    ownerPage.getByRole("row", { name: "Audit settlements.completed" }).filter({ hasText: serverWorker.name }),
  ).toHaveCount(1);
});
