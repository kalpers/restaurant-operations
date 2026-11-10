import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { confirmDialog, expectToast, openNavLink } from "../helpers/e2e-ui";

import {
  allSessionIdsAt,
  createE2eTable,
  createPermissionAccount,
  createRoleAccount,
  createStaff,
  openSessionIdsAt,
  putOnShift,
  removeRestaurantE2eData,
  SECTION_PREFIX,
  TABLE_PREFIX,
  type RestaurantAccount,
} from "../helpers/e2e-restaurant";

async function signIn(page: Page, account: RestaurantAccount) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

const mainNavigation = (page: Page) =>
  page.getByRole("navigation", { name: "Main" });

const card = (page: Page, tableNumber: string) =>
  page.getByRole("listitem", { name: `Table ${tableNumber}`, exact: true });

async function openFloor(page: Page) {
  await openNavLink(page, "Floor");
  await expect(page.getByRole("heading", { name: "Floor", exact: true })).toBeVisible();
}

async function selectTable(page: Page, tableNumber: string) {
  await card(page, tableNumber)
    .getByRole("checkbox", { name: `Select ${tableNumber}` })
    .check();
}

async function seat(page: Page, partySize: number) {
  const form = page.getByRole("form", { name: "Seat a party" });

  await form.getByLabel("Party size").fill(String(partySize));
  await form.getByRole("button", { name: "Seat party" }).click();
}

test.afterAll(async () => {
  await removeRestaurantE2eData();
});

test.describe("host seating", () => {
  test("seats a party at a clean table with a qualified server", async ({ page }) => {
    const owner = await createRoleAccount("OWNER");
    const host = await createRoleAccount("HOST");
    const table = await createE2eTable(owner);
    const staff = await createStaff(owner);

    await putOnShift(owner, staff);
    await signIn(page, host);
    await openFloor(page);

    await expect(card(page, table.tableNumber)).toContainText("Available");
    await selectTable(page, table.tableNumber);
    await page
      .getByRole("form", { name: "Seat a party" })
      .getByLabel("Server")
      .selectOption({ label: staff.displayName });
    await seat(page, 3);

    const seated = card(page, table.tableNumber);

    await expect(seated).toContainText("Occupied");
    await expect(seated).toContainText("Party of 3");
    await expect(seated).toContainText(`Server: ${staff.displayName}`);
    await expect(seated).toContainText("Seated 0 min");
    expect(await openSessionIdsAt(table.id)).toHaveLength(1);
  });

  test("seats a larger party at two tables under one session", async ({ page }) => {
    const owner = await createRoleAccount("OWNER");
    const host = await createRoleAccount("HOST");
    const first = await createE2eTable(owner, { capacity: 4 });
    const second = await createE2eTable(owner, { capacity: 4 });

    await signIn(page, host);
    await openFloor(page);
    await selectTable(page, first.tableNumber);
    await selectTable(page, second.tableNumber);
    await expect(page.getByRole("form", { name: "Seat a party" })).toContainText(
      "Seats 8",
    );
    await seat(page, 7);

    for (const table of [first, second]) {
      await expect(card(page, table.tableNumber)).toContainText("Party of 7");
    }

    const combined = /Combined: E2E-\S+ \+ E2E-\S+/;

    await expect(card(page, first.tableNumber)).toContainText(combined);
    await expect(card(page, second.tableNumber)).toContainText(combined);

    const [firstSession] = await openSessionIdsAt(first.id);
    const [secondSession] = await openSessionIdsAt(second.id);

    expect(firstSession).toBeDefined();
    expect(firstSession).toBe(secondSession);

    // Complete from one card: both tables end together and both need cleaning.
    await card(page, first.tableNumber)
      .getByRole("button", { name: "Complete session" })
      .click();
    await expect(card(page, first.tableNumber)).toContainText("Dirty");
    await expect(card(page, second.tableNumber)).toContainText("Dirty");
  });

  test("runs the dirty and clean lifecycle", async ({ page }) => {
    const owner = await createRoleAccount("OWNER");
    const host = await createRoleAccount("HOST");
    const table = await createE2eTable(owner);

    await signIn(page, host);
    await openFloor(page);
    await selectTable(page, table.tableNumber);
    await seat(page, 2);

    const current = card(page, table.tableNumber);

    await expect(current).toContainText("Occupied");
    await expect(current.getByRole("button", { name: "Mark clean" })).toHaveCount(0);

    await current.getByRole("button", { name: "Complete session" }).click();
    await expect(current).toContainText("Dirty");

    // It can't be selected on the screen, and the server refuses a direct call.
    await expect(current.getByRole("checkbox")).toHaveCount(0);

    const refused = await page.request.post("/api/restaurant/sessions", {
      data: { tableIds: [table.id], partySize: 2, serverEmployeeId: null },
    });

    expect(refused.status()).toBe(422);
    expect((await refused.json()).error.code).toBe("TABLE_DIRTY");

    await current.getByRole("button", { name: "Mark clean" }).click();
    await expect(current).toContainText("Available");
    await expect(
      current.getByRole("checkbox", { name: `Select ${table.tableNumber}` }),
    ).toBeVisible();
  });

  test("moves a party, and the old table needs cleaning", async ({ page }) => {
    const owner = await createRoleAccount("OWNER");
    const host = await createRoleAccount("HOST");
    const from = await createE2eTable(owner);
    const to = await createE2eTable(owner);

    await signIn(page, host);
    await openFloor(page);
    await selectTable(page, from.tableNumber);
    await seat(page, 2);

    const seated = card(page, from.tableNumber);

    await seated.getByText("Move or combine").click();
    await expect(seated).toContainText("Vacated tables will become DIRTY");
    await seated
      .getByRole("group", { name: "Move to" })
      .getByLabel(to.tableNumber)
      .check();
    await seated.getByRole("button", { name: "Move party" }).click();

    await expect(card(page, from.tableNumber)).toContainText("Dirty");
    await expect(card(page, to.tableNumber)).toContainText("Occupied");
    await expect(card(page, to.tableNumber)).toContainText("Party of 2");

    // The same session moved. No new one was created.
    const [moved] = await openSessionIdsAt(to.id);

    expect(moved).toBeDefined();
    expect(await allSessionIdsAt(from.id)).toEqual([moved]);
    expect(await openSessionIdsAt(from.id)).toEqual([]);
  });

  test("combines and removes a table on a seated party", async ({ page }) => {
    const owner = await createRoleAccount("OWNER");
    const host = await createRoleAccount("HOST");
    const first = await createE2eTable(owner);
    const extra = await createE2eTable(owner);

    await signIn(page, host);
    await openFloor(page);
    await selectTable(page, first.tableNumber);
    await seat(page, 2);

    const seated = card(page, first.tableNumber);

    await seated.getByText("Move or combine").click();
    await seated.getByLabel("Combine with").selectOption({ label: extra.tableNumber });
    await seated.getByRole("button", { name: "Combine table" }).click();
    await expect(card(page, extra.tableNumber)).toContainText("Occupied");

    // The panel stays open across the refresh.
    await card(page, first.tableNumber)
      .getByRole("button", { name: `Remove ${extra.tableNumber}` })
      .click();
    await expect(card(page, extra.tableNumber)).toContainText("Dirty");
    await expect(card(page, first.tableNumber)).toContainText("Occupied");
  });

  test("reassigns the server on a seated party", async ({ page }) => {
    const owner = await createRoleAccount("OWNER");
    const host = await createRoleAccount("HOST");
    const table = await createE2eTable(owner);
    const staff = await createStaff(owner);

    await putOnShift(owner, staff);
    await signIn(page, host);
    await openFloor(page);
    await selectTable(page, table.tableNumber);
    await seat(page, 2);

    const seated = card(page, table.tableNumber);

    await expect(seated).toContainText("Server: None");
    await seated.getByText("Reassign server").click();
    await seated.getByLabel("New server").selectOption({ label: staff.displayName });
    await seated.getByRole("button", { name: "Assign server" }).click();
    await expect(seated).toContainText(`Server: ${staff.displayName}`);
  });
});

test.describe("manager controls", () => {
  test("takes a table out of service and returns it", async ({ browser }) => {
    const owner = await createRoleAccount("OWNER");
    const table = await createE2eTable(owner);
    const managerPage = await (await browser.newContext()).newPage();
    const hostPage = await (await browser.newContext()).newPage();

    await signIn(managerPage, await createRoleAccount("MANAGER"));
    await signIn(hostPage, await createRoleAccount("HOST"));
    await openFloor(managerPage);

    await card(managerPage, table.tableNumber)
      .getByRole("button", { name: "Take out of service" })
      .click();
    await confirmDialog(managerPage, "Take out of service");
    await expect(card(managerPage, table.tableNumber)).toContainText("Out of service");

    await openFloor(hostPage);

    const asHost = card(hostPage, table.tableNumber);

    await expect(asHost).toContainText("Out of service");
    await expect(asHost.getByRole("checkbox")).toHaveCount(0);
    await expect(
      asHost.getByRole("button", { name: "Return to service as clean" }),
    ).toHaveCount(0);

    await card(managerPage, table.tableNumber)
      .getByRole("button", { name: "Return to service as clean" })
      .click();
    await expect(card(managerPage, table.tableNumber)).toContainText("Available");

    await hostPage.reload();
    await expect(
      card(hostPage, table.tableNumber).getByRole("checkbox", {
        name: `Select ${table.tableNumber}`,
      }),
    ).toBeVisible();

    await managerPage.context().close();
    await hostPage.context().close();
  });

  test("denies a host going over capacity, and allows a manager with a reason", async ({
    browser,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const hostTable = await createE2eTable(owner, { capacity: 2 });
    const hostPage = await (await browser.newContext()).newPage();

    await signIn(hostPage, await createRoleAccount("HOST"));
    await openFloor(hostPage);
    await selectTable(hostPage, hostTable.tableNumber);

    const hostForm = hostPage.getByRole("form", { name: "Seat a party" });

    await hostForm.getByLabel("Party size").fill("3");
    await expect(hostForm).toContainText("A manager can override this");
    await expect(hostForm.getByLabel("Capacity override reason")).toHaveCount(0);
    await hostForm.getByRole("button", { name: "Seat party" }).click();
    await expect(hostForm.getByRole("alert")).toContainText("over the capacity of 2");
    expect(await openSessionIdsAt(hostTable.id)).toEqual([]);

    // Sent directly, the reason doesn't help: the server checks the permission.
    const direct = await hostPage.request.post("/api/restaurant/sessions", {
      data: {
        tableIds: [hostTable.id],
        partySize: 3,
        serverEmployeeId: null,
        capacityOverrideReason: "Please",
      },
    });

    expect(direct.status()).toBe(403);
    await hostPage.context().close();

    const managerPage = await (await browser.newContext()).newPage();

    await signIn(managerPage, await createRoleAccount("MANAGER"));
    await openFloor(managerPage);
    await selectTable(managerPage, hostTable.tableNumber);

    const managerForm = managerPage.getByRole("form", { name: "Seat a party" });

    await managerForm.getByLabel("Party size").fill("3");
    await managerForm.getByRole("button", { name: "Seat party" }).click();
    await expect(managerForm.getByRole("alert")).toContainText("Give a reason");

    await managerForm.getByLabel("Capacity override reason").fill("Extra chair");
    await managerForm.getByRole("button", { name: "Seat party" }).click();

    const seated = card(managerPage, hostTable.tableNumber);

    await expect(seated).toContainText("Party of 3");
    await expect(seated).toContainText("Seated over capacity");
    await managerPage.context().close();
  });

  test("requires a manager's override to seat with a server who isn't on shift", async ({
    browser,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const table = await createE2eTable(owner);
    const staff = await createStaff(owner);
    const hostPage = await (await browser.newContext()).newPage();

    await signIn(hostPage, await createRoleAccount("HOST"));
    await openFloor(hostPage);
    await selectTable(hostPage, table.tableNumber);

    const hostForm = hostPage.getByRole("form", { name: "Seat a party" });

    await hostForm
      .getByLabel("Server")
      .selectOption({ label: `${staff.displayName} (not on shift)` });
    await hostForm.getByRole("button", { name: "Seat party" }).click();
    await expect(hostForm.getByRole("alert")).toContainText("published shift");
    await hostPage.context().close();

    const managerPage = await (await browser.newContext()).newPage();

    await signIn(managerPage, await createRoleAccount("MANAGER"));
    await openFloor(managerPage);
    await selectTable(managerPage, table.tableNumber);

    const managerForm = managerPage.getByRole("form", { name: "Seat a party" });

    await managerForm
      .getByLabel("Server")
      .selectOption({ label: `${staff.displayName} (not on shift)` });
    await managerForm.getByLabel("Schedule override reason").fill("Covering a sick call");
    await managerForm.getByRole("button", { name: "Seat party" }).click();
    await expect(card(managerPage, table.tableNumber)).toContainText(
      `Server: ${staff.displayName}`,
    );
    await managerPage.context().close();
  });

  test("cancels a mistaken seating and leaves the table clean", async ({ page }) => {
    const owner = await createRoleAccount("OWNER");
    const table = await createE2eTable(owner);

    await signIn(page, await createRoleAccount("MANAGER"));
    await openFloor(page);
    await selectTable(page, table.tableNumber);
    await seat(page, 2);

    const seated = card(page, table.tableNumber);

    await seated.getByText("Cancel seating").click();
    await seated.getByLabel("Reason", { exact: true }).fill("Wrong party");
    await seated.getByRole("button", { name: "Cancel this seating" }).click();
    await expect(seated).toContainText("Available");
  });

  test("configures a table and a section, and assigns a server", async ({ page }) => {
    const owner = await createRoleAccount("OWNER");
    const staff = await createStaff(owner);
    const tableNumber = `${TABLE_PREFIX}${randomUUID().slice(0, 8)}`;
    const code = `${SECTION_PREFIX}${randomUUID().slice(0, 8).toUpperCase().replaceAll("-", "_")}`;

    await putOnShift(owner, staff);
    await signIn(page, await createRoleAccount("MANAGER"));

    await mainNavigation(page).getByRole("link", { name: "Tables", exact: true }).click();
    await page.getByLabel("Table number").first().fill(tableNumber);
    await page.getByLabel("Area").first().selectOption({ label: "Dining Room" });
    await page.getByLabel("Capacity", { exact: true }).first().fill("4");
    await page.getByRole("button", { name: "Add table" }).click();

    const row = page.getByRole("listitem", { name: `Table ${tableNumber}`, exact: true });

    await expect(row).toBeVisible();
    await expect(page.locator("select option", { hasText: "Takeout" })).toHaveCount(0);

    await row.getByLabel("Capacity", { exact: true }).fill("6");
    await row.getByRole("button", { name: "Save table" }).click();
    await expectToast(page, "Saved.");

    await mainNavigation(page).getByRole("link", { name: "Sections", exact: true }).click();
    await page.getByLabel("Code").fill(code);
    await page.getByLabel("Name").first().fill("E2E section");
    await page.getByLabel("Area").first().selectOption({ label: "Dining Room" });
    await page.getByRole("button", { name: "Add section" }).click();

    const section = page.getByRole("listitem", { name: `Section ${code}`, exact: true });

    await section.getByRole("checkbox", { name: tableNumber }).check();
    await section.getByRole("button", { name: "Save tables" }).click();
    await section
      .getByLabel("Server")
      .selectOption({ label: staff.displayName });
    await section.getByRole("button", { name: "Assign server" }).click();
    await expect(section.getByRole("button", { name: "End assignment" })).toBeVisible();
    await expect(section).toContainText(staff.displayName);

    // A new party at that table defaults to the section's server.
    await openFloor(page);
    await selectTable(page, tableNumber);
    await seat(page, 2);
    await expect(card(page, tableNumber)).toContainText(`Server: ${staff.displayName}`);
    await expect(card(page, tableNumber)).toContainText("E2E section");

    // Ending the section's assignment doesn't take the server from the seated party.
    await mainNavigation(page).getByRole("link", { name: "Sections", exact: true }).click();
    await page
      .getByRole("listitem", { name: `Section ${code}`, exact: true })
      .getByRole("button", { name: "End assignment" })
      .click();
    await confirmDialog(page, "End assignment");
    await expect(
      page
        .getByRole("listitem", { name: `Section ${code}`, exact: true })
        .getByRole("button", { name: "Assign server" }),
    ).toBeVisible();
    await openFloor(page);
    await expect(card(page, tableNumber)).toContainText(`Server: ${staff.displayName}`);
  });
});

test.describe("authorization", () => {
  test("a Server can't seat through a direct call, and has no seat control", async ({
    page,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const table = await createE2eTable(owner);

    await signIn(page, await createRoleAccount("SERVER"));
    await openFloor(page);

    await expect(card(page, table.tableNumber).getByRole("checkbox")).toHaveCount(0);

    const refused = await page.request.post("/api/restaurant/sessions", {
      data: { tableIds: [table.id], partySize: 2, serverEmployeeId: null },
    });

    expect(refused.status()).toBe(403);
    expect(await openSessionIdsAt(table.id)).toEqual([]);
  });

  test("a Host is refused structural configuration, on screen and by direct call", async ({
    page,
  }) => {
    await signIn(page, await createRoleAccount("HOST"));

    await expect(
      mainNavigation(page).getByRole("link", { name: "Tables", exact: true }),
    ).toHaveCount(0);
    await page.goto("/restaurant/tables");
    await expect(page).toHaveURL(/\/access-denied$/);
    await page.goto("/restaurant/sections");
    await expect(page).toHaveURL(/\/access-denied$/);

    const table = await page.request.post("/api/restaurant/tables", {
      data: {
        restaurantAreaId: "00000000-0000-4000-8000-000000000000",
        tableNumber: "NOPE",
        name: null,
        capacity: 2,
        minimumCapacity: null,
        sortOrder: null,
      },
    });
    const section = await page.request.post("/api/restaurant/sections", {
      data: { code: "NOPE", name: "Nope", restaurantAreaId: null },
    });

    expect(table.status()).toBe(403);
    expect(section.status()).toBe(403);
  });

  test("no restaurant permission gets no floor", async ({ page }) => {
    await signIn(page, await createPermissionAccount(["menu.view"]));

    await expect(
      mainNavigation(page).getByRole("link", { name: "Floor", exact: true }),
    ).toHaveCount(0);
    await page.goto("/restaurant/floor");
    await expect(page).toHaveURL(/\/access-denied$/);
    expect((await page.request.get("/api/restaurant/floor")).status()).toBe(403);
  });

  test("restaurant.view alone reads the floor and changes nothing", async ({ page }) => {
    const owner = await createRoleAccount("OWNER");
    const table = await createE2eTable(owner);

    await signIn(page, await createPermissionAccount(["restaurant.view"]));
    await openFloor(page);

    const current = card(page, table.tableNumber);

    await expect(current).toContainText("Available");
    await expect(current.getByRole("checkbox")).toHaveCount(0);
    await expect(current.getByRole("button")).toHaveCount(0);
    expect((await page.request.get("/api/restaurant/floor")).status()).toBe(200);
  });

  test("the floor API gives a host no restricted HR data", async ({ page }) => {
    const owner = await createRoleAccount("OWNER");
    const table = await createE2eTable(owner);
    const staff = await createStaff(owner);

    await putOnShift(owner, staff);
    await signIn(page, await createRoleAccount("HOST"));

    await page.request.post("/api/restaurant/sessions", {
      data: {
        tableIds: [table.id],
        partySize: 2,
        serverEmployeeId: staff.id,
      },
    });

    const response = await page.request.get("/api/restaurant/floor");
    const text = await response.text();

    expect(response.status()).toBe(200);
    expect(text).toContain(staff.displayName);

    for (const hidden of ["employmentStatus", "hourlyRate", "personalEmail", "phone"]) {
      expect(text).not.toContain(hidden);
    }
  });

  test("signed out, the API refuses and the pages go to login", async ({ page }) => {
    expect((await page.request.get("/api/restaurant/floor")).status()).toBe(401);
    expect(
      (
        await page.request.post("/api/restaurant/sessions", {
          data: { tableIds: [], partySize: 2 },
        })
      ).status(),
    ).toBe(401);
    await page.goto("/restaurant/floor");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("phone width", () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test("the floor works without horizontal scrolling", async ({ page }) => {
    const owner = await createRoleAccount("OWNER");
    const table = await createE2eTable(owner);

    await signIn(page, await createRoleAccount("HOST"));
    await openFloor(page);
    await selectTable(page, table.tableNumber);
    await seat(page, 2);
    await expect(card(page, table.tableNumber)).toContainText("Occupied");

    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );

    expect(scrollWidth).toBeLessThanOrEqual(375);

    const button = await card(page, table.tableNumber)
      .getByRole("button", { name: "Complete session" })
      .boundingBox();

    expect(button!.height).toBeGreaterThanOrEqual(44);
  });
});
