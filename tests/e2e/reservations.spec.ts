import { expect, test, type Page } from "@playwright/test";

import {
  createPermissionAccount,
  createRoleAccount,
  createRsvTable,
  guestName,
  holdOverridesFor,
  localAt,
  openSessionIdsAt,
  plannedTableIds,
  removeReservationE2eData,
  reservationNamed,
  reservationOf,
  reserveAt,
  sessionPartyAt,
  waitlistEntryFor,
  type ReservationAccount,
} from "../helpers/e2e-reservations";

async function signIn(page: Page, account: ReservationAccount) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

const hostViews = (page: Page) => page.getByRole("navigation", { name: "Host views" });
const tableCard = (page: Page, tableNumber: string) =>
  page.getByRole("listitem", { name: `Table ${tableNumber}`, exact: true });
const reservationCard = (page: Page, name: string) =>
  page.getByRole("listitem", { name: `Reservation for ${name}`, exact: true });
const waitlistCard = (page: Page, name: string) =>
  page.getByRole("listitem", { name: `Waitlist entry for ${name}`, exact: true });

async function openView(page: Page, view: "Floor" | "Reservations" | "Waitlist") {
  await hostViews(page).getByRole("link", { name: view, exact: true }).click();
  await expect(page.getByRole("heading", { name: view, exact: true })).toBeVisible();
}

test.afterAll(async () => {
  await removeReservationE2eData();
});

test.describe("reservation workflow", () => {
  test("creates, plans a table, checks in and seats at different tables", async ({
    page,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const host = await createRoleAccount("HOST");
    const planned = await createRsvTable(owner, { capacity: 4 });
    const actual = await createRsvTable(owner, { capacity: 4 });
    const name = guestName("Plan");
    const when = localAt(240);

    await signIn(page, host);
    await page.goto("/host/reservations");
    await expect(page.getByRole("heading", { name: "Reservations", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "New reservation" }).click();

    const form = page.getByRole("form", { name: "New reservation" });

    await form.getByLabel("Guest name").fill(name);
    await form.getByLabel("Party size").fill("3");
    await form.getByRole("textbox", { name: "Phone", exact: true }).fill("555-0142");
    await form.getByLabel("Date").fill(when.localDate);
    await form.getByLabel("Time").fill(when.localTime);
    await form.getByLabel("Special requests").fill("Booth please");
    await form.getByRole("checkbox", { name: planned.tableNumber, exact: true }).check();
    await form.getByRole("button", { name: "Create reservation" }).click();

    const card = reservationCard(page, name);

    await expect(card).toContainText("Confirmed");
    await expect(card).toContainText("Party of 3");
    await expect(card).toContainText("Special request");
    await expect(card).toContainText(`Planned: ${planned.tableNumber}`);

    // Planning is not occupancy.
    expect(await openSessionIdsAt(planned.id)).toEqual([]);

    await card.getByRole("button", { name: "Check in" }).click();
    await expect(card).toContainText("Checked in");

    await card.getByRole("button", { name: "Seat", exact: true }).click();

    const seatForm = page.getByRole("form", { name: "Seat reservation" });

    await seatForm.getByRole("button", { name: "Suggest tables" }).click();
    await expect(seatForm.getByRole("list", { name: "Suggested tables" })).toBeVisible();
    await seatForm.getByRole("checkbox", { name: actual.tableNumber, exact: true }).check();
    await seatForm.getByRole("button", { name: "Seat party" }).click();

    await expect(card).toContainText("Seated");
    await expect(card).toContainText(`Seated at ${actual.tableNumber}`);
    // The plan is kept, as history, and no longer holds the table.
    await expect(card).toContainText(`${planned.tableNumber} (ended)`);

    const { party, reservation } = await reservationNamed(name);

    expect(reservation.status).toBe("SEATED");
    expect(await plannedTableIds(reservation.id)).toEqual([
      { tableId: planned.id, ended: true, reason: "SEATED" },
    ]);
    expect(await sessionPartyAt(actual.id)).toBe(party.id);
    expect(await openSessionIdsAt(planned.id)).toEqual([]);

    await openView(page, "Floor");
    await expect(tableCard(page, actual.tableNumber)).toContainText("Occupied");
    await expect(tableCard(page, actual.tableNumber)).toContainText("Party of 3");
    await expect(tableCard(page, planned.tableNumber)).toContainText("Available");

    await tableCard(page, actual.tableNumber)
      .getByRole("button", { name: "Complete session" })
      .click();
    await expect(tableCard(page, actual.tableNumber)).toContainText("Dirty");
    expect((await reservationOf(reservation.id)).status).toBe("COMPLETED");
  });
});

test.describe("waitlist workflow", () => {
  test("adds a walk-in, quotes, notifies and seats at a table", async ({ page }) => {
    const owner = await createRoleAccount("OWNER");
    const host = await createRoleAccount("HOST");
    const table = await createRsvTable(owner, { capacity: 2 });
    const name = guestName("Walk");

    await signIn(page, host);
    await page.goto("/host/waitlist");
    await expect(page.getByRole("heading", { name: "Waitlist", exact: true })).toBeVisible();

    const form = page.getByRole("form", { name: "Add walk-in" });

    await form.getByLabel("Guest name").fill(name);
    await form.getByLabel("Party size").fill("2");
    await form.getByRole("button", { name: "Suggest a quote" }).click();
    await expect(form.getByRole("status")).toBeVisible();
    await form.getByLabel("Quoted wait (minutes)").fill("20");
    await form.getByRole("button", { name: "Add to waitlist" }).click();

    const card = waitlistCard(page, name);

    await expect(card).toContainText("Waiting");
    await expect(card).toContainText("Quoted wait: 20 min");

    await card.getByRole("button", { name: "Edit quote" }).click();
    await card.getByLabel("Quoted wait (minutes)").fill("30");
    await card.getByRole("button", { name: "Save quote" }).click();
    await expect(card).toContainText("Quoted wait: 30 min");

    await card.getByRole("button", { name: "Mark notified" }).click();
    await expect(card).toContainText("Notified");
    await expect(card.getByRole("button", { name: "Mark notified" })).toHaveCount(0);

    await card.getByRole("button", { name: "Seat", exact: true }).click();

    const seatForm = card.getByRole("form", { name: "Seat waitlist party" });

    await expect(seatForm.getByRole("list", { name: "Suggested tables" })).toBeVisible();
    await seatForm.getByRole("checkbox", { name: table.tableNumber, exact: true }).check();
    await seatForm.getByRole("button", { name: "Seat party" }).click();

    // Seated entries leave the waiting list.
    await expect(waitlistCard(page, name)).toHaveCount(0);

    const { party, entry } = await waitlistEntryFor(name);

    expect(entry.status).toBe("SEATED");
    expect(entry.notifiedAt).not.toBeNull();
    expect(await sessionPartyAt(table.id)).toBe(party.id);

    await openView(page, "Floor");
    await expect(tableCard(page, table.tableNumber)).toContainText("Occupied");
    await expect(tableCard(page, table.tableNumber)).toContainText("Party of 2");
  });

  test("records that a party left", async ({ page }) => {
    const host = await createRoleAccount("HOST");
    const name = guestName("Left");

    await signIn(page, host);
    await page.goto("/host/waitlist");

    const form = page.getByRole("form", { name: "Add walk-in" });

    await form.getByLabel("Guest name").fill(name);
    await form.getByRole("button", { name: "Add to waitlist" }).click();
    await waitlistCard(page, name).getByRole("button", { name: "Left" }).click();
    await expect(waitlistCard(page, name)).toHaveCount(0);

    expect((await waitlistEntryFor(name)).entry.status).toBe("LEFT");
  });
});

test.describe("reservation hold", () => {
  test("blocks a host, lets a manager override with a reason, and is not occupancy", async ({
    browser,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const host = await createRoleAccount("HOST");
    const manager = await createRoleAccount("MANAGER");
    const table = await createRsvTable(owner, { capacity: 4 });
    const name = guestName("Held");
    const reservation = await reserveAt(owner, 5, {
      guestName: name,
      partySize: 2,
      tableIds: [table.id],
    });

    // Never a physically occupied table: nothing is seated here.
    expect(await openSessionIdsAt(table.id)).toEqual([]);

    const hostPage = await (await browser.newContext()).newPage();

    await signIn(hostPage, host);
    await hostPage.goto("/restaurant/floor");

    const hostCard = tableCard(hostPage, table.tableNumber);

    await expect(hostCard).toContainText("Available");
    await expect(hostCard).toContainText("Reservation hold");
    await hostCard.getByRole("checkbox", { name: `Select ${table.tableNumber}` }).check();

    const hostForm = hostPage.getByRole("form", { name: "Seat a party" });

    await expect(hostForm).toContainText("A manager can override this.");
    await expect(hostForm.getByLabel("Hold override reason")).toHaveCount(0);
    await hostForm.getByRole("button", { name: "Seat party" }).click();
    await expect(hostPage.getByRole("alert").filter({ hasText: "held for a" })).toBeVisible();
    expect(await openSessionIdsAt(table.id)).toEqual([]);

    const managerPage = await (await browser.newContext()).newPage();

    await signIn(managerPage, manager);
    await managerPage.goto("/restaurant/floor");
    await tableCard(managerPage, table.tableNumber)
      .getByRole("checkbox", { name: `Select ${table.tableNumber}` })
      .check();

    const managerForm = managerPage.getByRole("form", { name: "Seat a party" });

    await managerForm.getByLabel("Hold override reason").fill("Regular guest, reservation moved");
    await managerForm.getByRole("button", { name: "Seat party" }).click();
    await expect(tableCard(managerPage, table.tableNumber)).toContainText("Occupied");

    const [override] = await holdOverridesFor(reservation.id);

    expect(override).toMatchObject({
      reason: "Regular guest, reservation moved",
      category: "RESERVATION_HOLD_OVERRIDE",
      restaurantTableId: table.id,
    });
    expect((await reservationOf(reservation.id)).status).toBe("CONFIRMED");
    expect(await plannedTableIds(reservation.id)).toEqual([
      { tableId: table.id, ended: false, reason: null },
    ]);
  });

  test("cancelling a reservation releases its hold", async ({ page }) => {
    const owner = await createRoleAccount("OWNER");
    const host = await createRoleAccount("HOST");
    const table = await createRsvTable(owner);
    const name = guestName("Cancel");

    await reserveAt(owner, 5, { guestName: name, tableIds: [table.id] });
    await signIn(page, host);
    await page.goto("/restaurant/floor");
    await expect(tableCard(page, table.tableNumber)).toContainText("Reservation hold");

    await openView(page, "Reservations");

    const card = reservationCard(page, name);

    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("form", { name: "Cancel reservation" })
      .getByRole("button", { name: "Confirm cancellation" })
      .click();
    await expect(reservationCard(page, name)).toHaveCount(0);

    await openView(page, "Floor");
    await expect(tableCard(page, table.tableNumber)).not.toContainText("Reservation hold");
    await tableCard(page, table.tableNumber)
      .getByRole("checkbox", { name: `Select ${table.tableNumber}` })
      .check();
    await page
      .getByRole("form", { name: "Seat a party" })
      .getByRole("button", { name: "Seat party" })
      .click();
    await expect(tableCard(page, table.tableNumber)).toContainText("Occupied");
  });

  test("a no-show is allowed only after the grace period, and releases the hold", async ({
    page,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const host = await createRoleAccount("HOST");
    const table = await createRsvTable(owner);
    const early = guestName("Early");
    const late = guestName("Late");

    await reserveAt(owner, -5, { guestName: early });
    const lateReservation = await reserveAt(owner, -20, {
      guestName: late,
      tableIds: [table.id],
    });

    await signIn(page, host);
    await page.goto("/host/reservations");
    await expect(
      reservationCard(page, early).getByRole("button", { name: "No-show" }),
    ).toBeDisabled();
    await reservationCard(page, late).getByRole("button", { name: "No-show" }).click();
    await expect(reservationCard(page, late)).toHaveCount(0);

    const row = await reservationOf(lateReservation.id);

    expect(row.status).toBe("NO_SHOW");
    expect(row.noShowByUserId).toBe(host.id);
    expect(await plannedTableIds(lateReservation.id)).toEqual([
      { tableId: table.id, ended: true, reason: "NO_SHOW" },
    ]);

    await page.getByLabel("Show completed, cancelled and no-shows").check();
    await expect(reservationCard(page, late)).toContainText("No-show");
  });
});

test.describe("authorization and layout", () => {
  test("a Server has no reservation or waitlist access, on screen or by direct call", async ({
    page,
  }) => {
    const server = await createRoleAccount("SERVER");

    await signIn(page, server);
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Reservations" }),
    ).toHaveCount(0);

    for (const url of ["/api/reservations", "/api/waitlist"]) {
      expect((await page.request.get(url)).status()).toBe(403);
    }

    // The floor shows hold indicators to anyone who can see it, without who reserved.
    const holds = await page.request.get("/api/reservations/holds");

    expect(holds.status()).toBe(200);
    expect(
      ((await holds.json()) as { holds: { guestName: string | null }[] }).holds.every(
        (hold) => hold.guestName === null,
      ),
    ).toBe(true);

    const create = await page.request.post("/api/reservations", {
      data: {
        guestName: guestName("Denied"),
        partySize: 2,
        ...localAt(300),
        source: "PHONE",
      },
    });

    expect(create.status()).toBe(403);
    await page.goto("/host/reservations");
    await expect(page).not.toHaveURL(/\/host\/reservations$/);
  });

  test("a viewer can read but not change reservations or the waitlist", async ({ page }) => {
    const viewer = await createPermissionAccount([
      "reservations.view",
      "waitlist.view",
      "restaurant.view",
    ]);

    await signIn(page, viewer);
    await page.goto("/host/reservations");
    await expect(page.getByRole("heading", { name: "Reservations", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New reservation" })).toHaveCount(0);

    await page.goto("/host/waitlist");
    await expect(page.getByRole("form", { name: "Add walk-in" })).toHaveCount(0);

    const denied = await page.request.post("/api/waitlist", {
      data: { guestName: guestName("Denied"), partySize: 2 },
    });

    expect(denied.status()).toBe(403);
  });

  test("signed out, the APIs refuse and the pages go to login", async ({ page }) => {
    expect((await page.request.get("/api/reservations")).status()).toBe(401);
    expect((await page.request.get("/api/waitlist")).status()).toBe(401);
    await page.goto("/host/waitlist");
    await expect(page).toHaveURL(/\/login/);
  });

  test("the host views work at phone width without horizontal scrolling", async ({ page }) => {
    const owner = await createRoleAccount("OWNER");
    const host = await createRoleAccount("HOST");
    const table = await createRsvTable(owner);

    await reserveAt(owner, 240, { guestName: guestName("Phone"), tableIds: [table.id] });
    await page.setViewportSize({ width: 375, height: 800 });
    await signIn(page, host);

    for (const path of ["/host/reservations", "/host/waitlist", "/restaurant/floor"]) {
      await page.goto(path);
      await expect(page.getByRole("navigation", { name: "Host views" })).toBeVisible();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );

      expect(overflow).toBeLessThanOrEqual(0);
    }

    await page.goto("/host/reservations");

    const heights = await page
      .getByRole("button", { name: "New reservation" })
      .evaluate((element) => element.getBoundingClientRect().height);

    expect(heights).toBeGreaterThanOrEqual(44);
  });
});
