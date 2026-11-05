import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import {
  addShift,
  assignStaff,
  createDraft,
  createPermissionAccount,
  createRoleAccount,
  createStaff,
  linkEmployee,
  nextWeek,
  publish,
  removeSchedulingE2eData,
  type SchedulingAccount,
} from "../helpers/e2e-scheduling";

async function signIn(page: Page, account: SchedulingAccount) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

const mainNavigation = (page: Page) =>
  page.getByRole("navigation", { name: "Main" });

test.afterAll(async () => {
  await removeSchedulingE2eData();
});

test.describe("manager scheduling", () => {
  test("builds a schedule by hand and coverage updates", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const staff = await createStaff(await createRoleAccount("OWNER"));
    const week = nextWeek();
    const name = `E2E ${randomUUID().slice(0, 8)}`;

    await signIn(page, manager);
    await mainNavigation(page)
      .getByRole("link", { name: "Scheduling", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Scheduling", exact: true }),
    ).toBeVisible();

    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Start date").fill(week.monday);
    await page.getByLabel("End date").fill(week.sunday);
    await page.getByRole("button", { name: "Create period" }).click();
    await page.getByRole("link", { name }).click();
    await expect(page.getByTestId("period-status")).toHaveText("Draft");

    const addShiftForm = page.locator("section", {
      has: page.getByRole("heading", { name: "Add a shift" }),
    });

    await addShiftForm.getByLabel("Position").selectOption({ label: "Server" });
    await addShiftForm.getByLabel("Date").fill(week.monday);
    await addShiftForm.getByLabel("Start", { exact: true }).fill("17:00");
    await addShiftForm.getByLabel("End", { exact: true }).fill("22:00");
    await addShiftForm.getByRole("button", { name: "Add shift" }).click();
    await expect(page.getByTestId("coverage-summary")).toHaveText(
      "0 of 1 slots filled, 1 open",
    );

    const shift = page.getByTestId("shift");

    await shift.getByLabel("Employee").selectOption({ label: staff.displayName });
    await shift.getByRole("button", { name: "Assign" }).click();
    await expect(page.getByTestId("coverage-summary")).toHaveText(
      "1 of 1 slots filled, 0 open",
    );
    await expect(shift.getByTestId("assignment")).toContainText(staff.displayName);
    await expect(shift.getByTestId("assignment")).toContainText("Manual");
  });

  test("Generate Draft fills what it can, explains it, and the manager can change it", async ({
    page,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const week = nextWeek();
    const draft = await createDraft(owner, week);

    // Staff from earlier tests in this file are eligible too, so the assertions below
    // are about provenance, not about which equally scored person wins the tie-break.
    await createStaff(owner);
    await addShift(owner, draft.id, { date: week.monday });
    await addShift(owner, draft.id, {
      date: week.tuesday,
      positionCode: "INVENTORY_MANAGER",
    });

    await signIn(page, owner);
    await page.goto(`/scheduling/${draft.id}`);
    await page.getByRole("button", { name: "Generate Draft" }).click();

    const generated = page.getByTestId("assignment").filter({
      hasText: "Generated",
    });

    await expect(generated).toHaveCount(1);
    await expect(page.getByTestId("period-status")).toHaveText("Draft");
    await expect(page.getByTestId("coverage-summary")).toContainText("1 open");
    await expect(page.getByText(/Still open:.*don't hold this position/)).toBeVisible();

    await generated.getByText("Why this assignment").click();
    await expect(generated.getByText("✓ Holds the position")).toBeVisible();
    await expect(generated.getByText("✓ Schedulable")).toBeVisible();
    await expect(generated).toContainText(/Score -?\d+/);
    await expect(page.locator("body")).not.toContainText(/wage|salary/i);

    await generated.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByTestId("coverage-summary")).toContainText("2 open");
  });

  test("Fill Open Shifts keeps manual assignments and fills the gaps", async ({
    page,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const manual = await createStaff(owner);
    const week = nextWeek();
    const draft = await createDraft(owner, week);

    await createStaff(owner);

    const shiftId = await addShift(owner, draft.id, {
      date: week.monday,
      required: 2,
    });

    await assignStaff(owner, draft.id, shiftId, manual.id);

    await signIn(page, owner);
    await page.goto(`/scheduling/${draft.id}`);
    await page.getByRole("button", { name: "Fill Open Shifts" }).click();

    await expect(page.getByTestId("coverage-summary")).toHaveText(
      "2 of 2 slots filled, 0 open",
    );
    await expect(
      page.getByTestId("assignment").filter({ hasText: manual.displayName }),
    ).toContainText("Manual");
    await expect(
      page.getByTestId("assignment").filter({ hasText: "Generated" }),
    ).toHaveCount(1);
  });

  test("publishing is explicit, and a published schedule has no edit controls", async ({
    page,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const staff = await createStaff(owner);
    const week = nextWeek();
    const draft = await createDraft(owner, week);
    const shiftId = await addShift(owner, draft.id, { date: week.monday });

    await assignStaff(owner, draft.id, shiftId, staff.id);

    await signIn(page, owner);
    await page.goto(`/scheduling/${draft.id}`);
    await page.getByRole("button", { name: "Publish" }).click();

    await expect(page.getByTestId("period-status")).toHaveText("Published");
    await expect(page.getByRole("button", { name: "Generate Draft" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Publish" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Archive" })).toBeVisible();
  });

  test("staffing template and rules are configured through the UI", async ({
    page,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const week = nextWeek();
    const draft = await createDraft(owner, week);
    const templateName = `Template ${randomUUID().slice(0, 8)}`;

    await signIn(page, owner);
    await page.goto("/scheduling/staffing");
    await page.getByLabel("Template name").fill(templateName);
    await page.getByRole("button", { name: "Create template" }).click();

    const template = page.getByTestId("staffing-template").filter({
      hasText: templateName,
    });

    await template.getByText("Add a requirement").click();
    await template.getByLabel("Day").selectOption({ label: "Monday" });
    await template.getByLabel("Position").selectOption({ label: "Server" });
    await template.getByLabel("Start", { exact: true }).fill("22:00");
    await template.getByLabel("End", { exact: true }).fill("02:00");
    await template.getByRole("button", { name: "Add requirement" }).click();
    await expect(template).toContainText("Monday, 22:00 to 02:00: Server");

    await page.goto(`/scheduling/${draft.id}`);
    await page.getByLabel("Template").selectOption({ label: templateName });
    await page.getByRole("button", { name: "Apply template" }).click();
    await expect(page.getByTestId("shift")).toContainText(`${week.monday} · 22:00 to 02:00`);

    await page.goto("/scheduling/staffing");
    await expect(page.getByLabel("Weekly overtime threshold (hours)")).toBeVisible();
    await expect(page.getByLabel("Minimum rest is a hard limit")).toBeVisible();
    await expect(page.locator("body")).toContainText("labor law");
  });
});

test.describe("employee self-service", () => {
  test("sees own published shifts only, requests time off, and can't target others", async ({
    page,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const account = await createRoleAccount("SERVER");
    const me = await createStaff(owner);
    const someoneElse = await createStaff(owner);
    const week = nextWeek();
    const draftWeek = nextWeek();
    const published = await createDraft(owner, week);
    const shiftId = await addShift(owner, published.id, { date: week.monday });
    const draft = await createDraft(owner, draftWeek);
    const draftShift = await addShift(owner, draft.id, {
      date: draftWeek.monday,
    });

    await linkEmployee(me.id, account);
    await assignStaff(owner, published.id, shiftId, me.id);
    await assignStaff(owner, draft.id, draftShift, me.id);
    await publish(owner, published.id);

    await signIn(page, account);
    await mainNavigation(page).getByRole("link", { name: "My schedule" }).click();
    await expect(page.getByTestId("my-shift")).toHaveCount(1);
    await expect(page.getByTestId("my-shift")).toContainText(week.monday);
    await expect(page.locator("body")).not.toContainText(draftWeek.monday);

    await expect(
      page.getByRole("heading", { name: "Availability", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Preferences" })).toBeVisible();

    const timeOff = page.locator("section", {
      has: page.getByRole("heading", { name: "Time off" }),
    });

    await timeOff.getByLabel("First day").fill(week.sunday);
    await timeOff.getByLabel("Last day").fill(week.sunday);
    await timeOff.getByRole("button", { name: "Request time off" }).click();
    await expect(page.getByTestId("my-time-off")).toContainText("Pending");

    // The manager path, naming someone else, is refused on the server.
    const asOther = await page.request.post("/api/scheduling/time-off", {
      data: {
        employeeId: someoneElse.id,
        startDate: week.sunday,
        endDate: week.sunday,
        requestType: "VACATION",
      },
    });

    expect(asOther.status()).toBe(403);

    // A draft isn't reachable by URL for someone who can't review schedules.
    await page.goto(`/scheduling/${draft.id}`);
    await expect(page.locator("body")).not.toContainText(draft.name);
  });

  test("a swap goes from the employee, through acceptance, to manager approval", async ({
    page,
    browser,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const account = await createRoleAccount("SERVER");
    const me = await createStaff(owner);
    const target = await createStaff(owner);
    const week = nextWeek();
    const published = await createDraft(owner, week);
    const shiftId = await addShift(owner, published.id, { date: week.monday });

    await linkEmployee(me.id, account);
    await assignStaff(owner, published.id, shiftId, me.id);
    await publish(owner, published.id);

    await signIn(page, account);
    await page.goto("/my-schedule");

    const shift = page.getByTestId("my-shift");

    await shift.getByText("Request a swap").click();
    await shift
      .getByLabel("Who could take it")
      .selectOption({ label: target.displayName });
    await shift.getByRole("button", { name: "Request swap" }).click();
    await expect(page.getByRole("heading", { name: "Shift swaps" })).toBeVisible();

    const context = await browser.newContext();
    const managerPage = await context.newPage();

    await signIn(managerPage, owner);
    await managerPage.goto("/scheduling/requests");

    const request = managerPage.getByTestId("swap-request").filter({
      hasText: week.monday,
    });

    await request.getByRole("button", { name: "Record acceptance" }).click();
    await request.getByRole("button", { name: "Approve swap" }).click();
    await expect(request).toContainText("Completed");

    await managerPage.goto(`/scheduling/${published.id}`);
    await expect(managerPage.getByTestId("assignment")).toContainText(
      target.displayName,
    );
    await expect(managerPage.getByTestId("assignment")).toContainText("Shift swap");
    await context.close();
  });

  test("a manager sees a time-off conflict before approving", async ({ page }) => {
    const owner = await createRoleAccount("OWNER");
    const account = await createRoleAccount("SERVER");
    const me = await createStaff(owner);
    const week = nextWeek();
    const draft = await createDraft(owner, week);
    const shiftId = await addShift(owner, draft.id, { date: week.monday });

    await linkEmployee(me.id, account);
    await assignStaff(owner, draft.id, shiftId, me.id);

    await signIn(page, account);

    const created = await page.request.post("/api/scheduling/me/time-off", {
      data: {
        startDate: week.monday,
        endDate: week.monday,
        requestType: "VACATION",
      },
    });

    expect(created.status()).toBe(201);

    await page.context().clearCookies();
    await signIn(page, owner);
    await page.goto("/scheduling/requests");

    const request = page.getByTestId("time-off-request").filter({
      hasText: me.displayName,
    });

    await expect(request).toContainText("Can't be approved until these are resolved");
    await request.getByRole("button", { name: "Approve" }).click();
    await expect(request.getByRole("alert")).toContainText("Resolve them first");
  });
});

test.describe("permission boundary", () => {
  test("schedule.view alone can view but can't generate or publish", async ({
    page,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const viewer = await createPermissionAccount(["schedule.view"]);
    const week = nextWeek();
    const published = await createDraft(owner, week);

    await addShift(owner, published.id, { date: week.monday });
    await publish(owner, published.id);

    const draftWeek = nextWeek();
    const draft = await createDraft(owner, draftWeek);

    await signIn(page, viewer);
    await page.goto(`/scheduling/${published.id}`);
    await expect(page.getByTestId("period-status")).toHaveText("Published");
    await expect(page.getByRole("button", { name: "Generate Draft" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Publish" })).toHaveCount(0);
    await expect(page.getByTestId("coverage-summary")).toHaveCount(0);

    for (const [url, data] of [
      [`/api/scheduling/periods/${draft.id}/generate`, { mode: "GENERATE_DRAFT", expectedVersion: 1 }],
      [`/api/scheduling/periods/${draft.id}/publish`, { expectedVersion: 1 }],
      [`/api/scheduling/periods/${draft.id}/shifts`, { positionId: draft.id, shiftDate: draftWeek.monday, startTime: "09:00", endTime: "10:00", expectedPeriodVersion: 1 }],
      ["/api/scheduling/rules", { avoidOvertime: true }],
    ] as const) {
      const response = await (url === "/api/scheduling/rules"
        ? page.request.put(url, { data })
        : page.request.post(url, { data }));

      expect([403, 400]).toContain(response.status());

      if (url.endsWith("generate") || url.endsWith("publish")) {
        expect(response.status()).toBe(403);
      }
    }

    const coverage = await page.request.get(
      `/api/scheduling/periods/${published.id}/coverage`,
    );
    const draftDetail = await page.request.get(
      `/api/scheduling/periods/${draft.id}`,
    );

    expect(coverage.status()).toBe(403);
    expect(draftDetail.status()).toBe(404);
  });

  test("no scheduling permission means no page and no API", async ({ page }) => {
    const outsider = await createPermissionAccount(["menu.view"]);

    await signIn(page, outsider);
    await expect(
      mainNavigation(page).getByRole("link", { name: "Scheduling" }),
    ).toHaveCount(0);

    await page.goto("/scheduling");
    await expect(page).toHaveURL(/\/access-denied$/);

    const response = await page.request.get("/api/scheduling/periods");

    expect(response.status()).toBe(403);
  });

  test("signed out, the API refuses and pages go to login", async ({ page }) => {
    const response = await page.request.get("/api/scheduling/periods");

    expect(response.status()).toBe(401);

    await page.goto("/scheduling");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("responsive layout", () => {
  test("My schedule fits a phone without sideways scrolling", async ({ page }) => {
    const owner = await createRoleAccount("OWNER");
    const account = await createRoleAccount("SERVER");
    const me = await createStaff(owner);
    const week = nextWeek();
    const published = await createDraft(owner, week);
    const shiftId = await addShift(owner, published.id, { date: week.monday });

    await linkEmployee(me.id, account);
    await assignStaff(owner, published.id, shiftId, me.id);
    await publish(owner, published.id);

    await page.setViewportSize({ width: 375, height: 800 });
    await signIn(page, account);
    await page.goto("/my-schedule");
    await expect(page.getByTestId("my-shift")).toBeVisible();

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );

    expect(overflow).toBeLessThanOrEqual(0);
  });
});
