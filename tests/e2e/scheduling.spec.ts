import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { confirmDialog } from "../helpers/e2e-ui";

import {
  addShift,
  approvedTimeOff,
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
    await confirmDialog(page, "Remove assignment");
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
    await confirmDialog(page, "Publish");

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

test.describe("schedule timeline", () => {
  const nextDate = (date: string, days: number) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

  /** A published day: one staffed Server shift and a Bartender shift needing 2 with nobody. */
  async function publishedDay() {
    const owner = await createRoleAccount("OWNER");
    const staff = await createStaff(owner);
    const week = nextWeek();
    const period = await createDraft(owner, week);
    const shiftId = await addShift(owner, period.id, { date: week.monday });

    await addShift(owner, period.id, {
      date: week.monday,
      positionCode: "BARTENDER",
      required: 2,
      start: "18:00",
      end: "23:00",
    });
    await assignStaff(owner, period.id, shiftId, staff.id);
    await publish(owner, period.id);

    return { owner, staff, week, period };
  }

  const barFor = (page: Page, displayName: string) =>
    page.getByRole("button", { name: new RegExp(`^${displayName}, Server`) });

  /** Server-rendered bars show before React hydrates; clicks and keys need it hydrated. */
  const timelineReady = (page: Page) =>
    expect(page.getByTestId("schedule-timeline")).toHaveAttribute("data-ready", "true");

  const openTimeline = async (page: Page, date: string) => {
    await page.goto(`/scheduling/timeline?date=${date}`);
    await timelineReady(page);
  };

  test("a manager groups the day, selects bars and reads the details", async ({ page }) => {
    const { owner, staff, week } = await publishedDay();
    const manager = await createRoleAccount("MANAGER");

    await approvedTimeOff(owner, staff.id, { date: week.monday, start: "09:00", end: "12:00" });
    await signIn(page, manager);
    await mainNavigation(page).getByRole("link", { name: "Timeline", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Schedule timeline" })).toBeVisible();
    await page.getByLabel("Date").fill(week.monday);
    await expect(page).toHaveURL(new RegExp(`date=${week.monday}`));

    const staffBar = barFor(page, staff.displayName);

    await expect(staffBar).toBeVisible();
    await expect(page.getByTestId("timeline-time-off")).toHaveText("Time off");
    await expect(page.getByTestId("timeline-headcount")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Open shifts" })).toBeVisible();

    await staffBar.click();

    const panel = page.getByTestId("timeline-panel");

    await expect(panel).toContainText(staff.displayName);
    await expect(panel).toContainText("17:00 to 22:00");
    await expect(panel).toContainText("Manual");
    await expect(panel.getByTestId("panel-period-status")).toHaveText("Published");
    await expect(page).toHaveURL(/selected=/);
    await expect(page.getByText("E2E private reason")).toHaveCount(0);

    await page.reload();
    await timelineReady(page);
    await expect(panel).toContainText(staff.displayName);
    await expect(panel.getByRole("button", { name: "Close" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(staffBar).toBeFocused();

    await staffBar.focus();
    await page.keyboard.press("Enter");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Close" }).click();
    await expect(panel).toHaveCount(0);

    await page.getByRole("link", { name: "By position" }).click();
    await expect(page).toHaveURL(/view=position/);
    await expect(page.getByRole("region", { name: "Bartender" })).toBeVisible();

    const openBars = page.locator('[data-testid="timeline-bar"][data-kind="OPEN"]');

    await expect(openBars).toHaveCount(2);
    await openBars.first().click();
    await expect(panel).toContainText("Open slot");
    await expect(panel).toContainText("0 of 2 filled");
  });

  test("previous, next and today move the day", async ({ page }) => {
    const { week } = await publishedDay();
    const manager = await createRoleAccount("MANAGER");

    await signIn(page, manager);
    await openTimeline(page, week.monday);
    await page.getByRole("link", { name: "Next day" }).click();
    await expect(page).toHaveURL(new RegExp(`date=${nextDate(week.monday, 1)}`));
    await page.getByRole("link", { name: "Previous day" }).click();
    await expect(page).toHaveURL(new RegExp(`date=${week.monday}`));
    await page.getByRole("link", { name: "Today" }).click();
    await expect(page).not.toHaveURL(new RegExp(`date=${week.monday}`));
    await expect(page.getByRole("heading", { name: "Schedule timeline" })).toBeVisible();
  });

  test("staff see published shifts only, with no reviewer details", async ({ page }) => {
    const { owner, staff, week } = await publishedDay();
    const draft = await createDraft(owner, week);
    const draftOnly = await createStaff(owner);
    const draftShift = await addShift(owner, draft.id, {
      date: week.monday,
      start: "08:00",
      end: "12:00",
    });

    await assignStaff(owner, draft.id, draftShift, draftOnly.id);
    await approvedTimeOff(owner, staff.id, { date: week.monday, start: "09:00", end: "12:00" });

    const server = await createRoleAccount("SERVER");

    await signIn(page, server);
    await openTimeline(page, week.monday);

    const staffBar = barFor(page, staff.displayName);

    await expect(staffBar).toBeVisible();
    await expect(barFor(page, draftOnly.displayName)).toHaveCount(0);
    await expect(page.getByLabel("Include drafts")).toHaveCount(0);
    await expect(page.getByTestId("timeline-time-off")).toHaveCount(0);

    await staffBar.click();
    await expect(page.getByTestId("timeline-panel")).toContainText("17:00 to 22:00");
    await expect(page.getByTestId("panel-reviewer")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open this schedule" })).toHaveCount(0);
  });

  test("fits a phone: the chart scrolls in its frame and details open as a sheet", async ({
    page,
  }) => {
    const { staff, week } = await publishedDay();
    const server = await createRoleAccount("SERVER");

    await page.setViewportSize({ width: 375, height: 800 });
    await signIn(page, server);
    await openTimeline(page, week.monday);
    await expect(page.getByTestId("timeline-frame")).toBeVisible();

    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    const frameScrolls = await page
      .getByTestId("timeline-frame")
      .evaluate((element) => element.scrollWidth > element.clientWidth);

    expect(pageOverflow).toBeLessThanOrEqual(0);
    expect(frameScrolls).toBe(true);

    await barFor(page, staff.displayName).click();

    const box = await page.getByTestId("timeline-panel").boundingBox();

    expect(box).not.toBeNull();
    expect(Math.round(box?.x ?? -1)).toBe(0);
    expect(Math.round(box?.width ?? 0)).toBe(375);
    expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(800);
  });

  test("the API refuses without a session or schedule.view, and checks the date", async ({
    page,
  }) => {
    const signedOut = await page.request.get("/api/scheduling/timeline?date=2030-01-07");

    expect(signedOut.status()).toBe(401);

    await signIn(page, await createPermissionAccount(["menu.view"]));

    const forbidden = await page.request.get("/api/scheduling/timeline?date=2030-01-07");

    expect(forbidden.status()).toBe(403);

    await page.goto("/scheduling/timeline");
    await expect(page).toHaveURL(/\/access-denied$/);

    await page.context().clearCookies();
    await signIn(page, await createPermissionAccount(["schedule.view"]));

    const invalid = await page.request.get("/api/scheduling/timeline?date=2030-02-30");
    const body = (await invalid.json()) as { error: { code: string; requestId: string } };

    expect(invalid.status()).toBe(400);
    expect(body.error.requestId).toBeTruthy();

    const ok = await page.request.get("/api/scheduling/timeline?date=2030-01-07");

    expect(ok.status()).toBe(200);
    expect(ok.headers()["cache-control"]).toContain("no-store");
  });
});
