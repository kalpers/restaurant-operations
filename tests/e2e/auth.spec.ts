import { expect, test, type Page } from "@playwright/test";

import {
  assignAt,
  createAccount,
  createSecondLocation,
  disableAccount,
  findAccountEmails,
  findLocationName,
  findMainLocationId,
  findRoleId,
  generatePassword,
  removeE2eAccounts,
  uniqueE2eEmail,
  type E2eAccount,
} from "../helpers/e2e-accounts";

async function signIn(page: Page, account: Pick<E2eAccount, "email" | "password">) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function signInAndWait(page: Page, account: E2eAccount) {
  await signIn(page, account);
  await expect(page).toHaveURL(/\/dashboard$/);
}

const mainNav = (page: Page) => page.getByRole("navigation", { name: "Main" });

test.afterAll(async () => {
  await removeE2eAccounts();
});

test.describe("login", () => {
  test("valid credentials reach the protected shell", async ({ page }) => {
    const owner = await createAccount("OWNER");

    await signInAndWait(page, owner);

    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText(owner.email)).toBeVisible();
    await expect(page.getByText("Main Restaurant")).toBeVisible();
  });

  test("a wrong password and an unknown email get the same generic error", async ({
    page,
  }) => {
    const owner = await createAccount("OWNER");

    await signIn(page, { email: owner.email, password: generatePassword() });
    await expect(page.getByText("Invalid email or password")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);

    await signIn(page, {
      email: uniqueE2eEmail(),
      password: generatePassword(),
    });
    await expect(page.getByText("Invalid email or password")).toBeVisible();

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("a disabled account gets the same generic error", async ({ page }) => {
    const user = await createAccount("SERVER");

    await disableAccount(user.id);
    await signIn(page, user);

    await expect(page.getByText("Invalid email or password")).toBeVisible();
  });

  test("the session cookie is HttpOnly and SameSite=Lax", async ({
    page,
    context,
  }) => {
    await signInAndWait(page, await createAccount("OWNER"));

    const cookies = await context.cookies();
    const session = cookies.find((cookie) =>
      cookie.name.includes("session-token"),
    );

    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe("Lax");
  });

  test("a signed-in user is sent from the login page to the dashboard", async ({
    page,
  }) => {
    await signInAndWait(page, await createAccount("OWNER"));

    await page.goto("/login");

    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("there is no public registration", async ({ page, request }) => {
    await page.goto("/login");

    await expect(
      page.getByRole("link", { name: /sign up|register/i }),
    ).toHaveCount(0);

    for (const path of ["/signup", "/register", "/api/register"]) {
      expect((await request.get(path)).status(), path).toBe(404);
    }
  });
});

test.describe("logout", () => {
  test("ends access to protected pages and APIs", async ({ page }) => {
    await signInAndWait(page, await createAccount("OWNER"));

    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);

    expect((await page.request.get("/api/admin/users")).status()).toBe(401);
  });
});

test.describe("signed out", () => {
  test("protected pages redirect to login", async ({ page }) => {
    for (const path of ["/dashboard", "/admin/users", "/admin/roles"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/login$/);
    }
  });

  test("protected APIs return the structured 401", async ({ request }) => {
    const response = await request.get("/api/admin/users");
    const body = await response.json();

    expect(response.status()).toBe(401);
    expect(body.error.code).toBe("AUTHENTICATION_REQUIRED");
    expect(body.error.requestId).toEqual(expect.any(String));
  });
});

test.describe("direct server authorization", () => {
  test("an authenticated Server is rejected by protected APIs", async ({
    page,
  }) => {
    await signInAndWait(page, await createAccount("SERVER"));
    const email = uniqueE2eEmail();

    const list = await page.request.get("/api/admin/users");
    const create = await page.request.post("/api/admin/users", {
      data: {
        email,
        password: generatePassword(),
        roleId: "00000000-0000-4000-8000-000000000000",
      },
    });
    const organization = await page.request.patch("/api/admin/organization", {
      data: {},
    });

    for (const response of [list, create, organization]) {
      expect(response.status()).toBe(403);
      expect((await response.json()).error.code).toBe("PERMISSION_DENIED");
    }

    expect(await findAccountEmails(email)).toEqual([]);
  });

  test("an authenticated Server is denied admin pages by URL", async ({
    page,
  }) => {
    await signInAndWait(page, await createAccount("SERVER"));

    for (const path of [
      "/admin/users",
      "/admin/roles",
      "/admin/permissions",
      "/admin/organization",
      "/admin/locations",
      "/admin/areas",
    ]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/access-denied$/);
      await expect(
        page.getByRole("heading", { name: "Access denied" }),
      ).toBeVisible();
    }
  });

  test("user lists expose no credential fields", async ({ page }) => {
    await signInAndWait(page, await createAccount("OWNER"));

    const response = await page.request.get("/api/admin/users");
    const text = await response.text();

    expect(response.status()).toBe(200);
    expect(text).not.toMatch(/passwordHash|password_hash|argon2/);
  });

  test("a General Manager cannot give anyone the Owner role", async ({
    page,
  }) => {
    const manager = await createAccount("GENERAL_MANAGER");

    await signInAndWait(page, manager);
    await page.goto("/admin/users");
    await expect(page.getByRole("option", { name: "Owner" })).toHaveCount(0);

    // The server refuses it too, even when the role's ID is sent directly.
    const response = await page.request.post(
      `/api/admin/users/${manager.id}/roles`,
      { data: { roleId: await findRoleId("OWNER") } },
    );

    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe("PERMISSION_DENIED");
  });
});

test.describe("disabled user", () => {
  test("loses access on the next request despite a valid session", async ({
    page,
  }) => {
    const owner = await createAccount("OWNER");

    await signInAndWait(page, owner);
    expect((await page.request.get("/api/admin/users")).status()).toBe(200);

    await disableAccount(owner.id);

    expect((await page.request.get("/api/admin/users")).status()).toBe(401);
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("permission-aware navigation", () => {
  test("differs by role", async ({ browser }) => {
    const expectations = [
      {
        role: "OWNER",
        visible: ["Dashboard", "Organization", "Users", "Roles", "Permissions"],
        hidden: [],
      },
      {
        role: "MANAGER",
        visible: ["Dashboard", "Organization", "Users"],
        hidden: ["Roles", "Permissions"],
      },
      {
        role: "SERVER",
        visible: ["Dashboard"],
        hidden: ["Organization", "Locations", "Users", "Roles", "Permissions"],
      },
    ];

    for (const { role, visible, hidden } of expectations) {
      const context = await browser.newContext();
      const page = await context.newPage();

      await signInAndWait(page, await createAccount(role));

      for (const label of visible) {
        await expect(
          mainNav(page).getByRole("link", { name: label, exact: true }),
          `${role} sees ${label}`,
        ).toBeVisible();
      }

      for (const label of hidden) {
        await expect(
          mainNav(page).getByRole("link", { name: label, exact: true }),
          `${role} doesn't see ${label}`,
        ).toHaveCount(0);
      }

      await context.close();
    }
  });
});

test.describe("location-aware authorization", () => {
  const locationUpdate = {
    name: "Should not be saved",
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
    country: "US",
    phone: null,
    email: null,
    timezone: "America/Detroit",
    expectedVersion: 1,
  };

  test("an Owner at one location can't update another by its URL", async ({
    page,
  }) => {
    const secondLocation = await createSecondLocation();
    const name = await findLocationName(secondLocation);

    await signInAndWait(page, await createAccount("OWNER"));

    const response = await page.request.patch(
      `/api/admin/locations/${secondLocation}`,
      { data: locationUpdate },
    );

    expect(response.status()).toBe(403);
    expect(await findLocationName(secondLocation)).toBe(name);
  });

  test("a user can't select a location they have no role at", async ({
    page,
  }) => {
    const secondLocation = await createSecondLocation();

    await signInAndWait(page, await createAccount("OWNER"));

    const response = await page.request.put("/api/session/location", {
      data: { locationId: secondLocation },
    });

    expect(response.status()).toBe(403);
  });

  test("a forged location cookie grants nothing", async ({ page, context }) => {
    const secondLocation = await createSecondLocation();

    await signInAndWait(page, await createAccount("SERVER"));
    await context.addCookies([
      {
        name: "restaurant_ops_location",
        value: secondLocation,
        domain: "localhost",
        path: "/",
      },
    ]);

    expect((await page.request.get("/api/admin/users")).status()).toBe(403);
    await page.goto("/dashboard");
    await expect(page.getByText("Main Restaurant")).toBeVisible();
  });

  test("permissions and navigation follow the selected location", async ({
    page,
  }) => {
    const secondLocation = await createSecondLocation();
    const secondName = await findLocationName(secondLocation);
    const user = await createAccount("SERVER");

    await assignAt(user.id, "OWNER", secondLocation);
    await signInAndWait(page, user);

    const switcher = page.getByLabel("Location");
    const usersLink = mainNav(page).getByRole("link", {
      name: "Users",
      exact: true,
    });

    await switcher.selectOption({ label: secondName });
    await expect(usersLink).toBeVisible();
    expect((await page.request.get("/api/admin/users")).status()).toBe(200);

    await switcher.selectOption({ label: "Main Restaurant" });
    await expect(usersLink).toHaveCount(0);
    expect((await page.request.get("/api/admin/users")).status()).toBe(403);

    // Authority at the second location doesn't reach the first through its URL.
    const main = await page.request.patch(
      `/api/admin/locations/${await findMainLocationId()}`,
      { data: locationUpdate },
    );

    expect(main.status()).toBe(403);
  });

  test("the switcher doesn't appear for a single location", async ({ page }) => {
    await signInAndWait(page, await createAccount("OWNER"));

    await expect(page.getByLabel("Location")).toHaveCount(0);
  });
});

test.describe("administration", () => {
  test("an Owner provisions a user who can then sign in", async ({ browser }) => {
    const ownerContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    const email = uniqueE2eEmail();
    const password = generatePassword();

    await signInAndWait(ownerPage, await createAccount("OWNER"));
    await ownerPage.goto("/admin/users");

    const form = ownerPage.locator("section").filter({ hasText: "Add a user" });

    await form.getByLabel("Email").fill(email);
    await form.getByLabel(/Initial password/).fill(password);
    await form.getByLabel("Role at this location").selectOption({ label: "Server" });
    await form.getByRole("button", { name: "Create user" }).click();

    await expect(ownerPage.getByText(email)).toBeVisible();
    await ownerContext.close();

    const userContext = await browser.newContext();
    const userPage = await userContext.newPage();

    await signIn(userPage, { email, password });
    await expect(userPage).toHaveURL(/\/dashboard$/);
    await expect(userPage.getByText("Your roles here")).toBeVisible();
    await userContext.close();
  });

  test("an Owner disables a user through the Users page", async ({ page }) => {
    const server = await createAccount("SERVER");

    await signInAndWait(page, await createAccount("OWNER"));
    await page.goto("/admin/users");

    const row = page.getByRole("listitem").filter({ hasText: server.email });

    await row.getByRole("button", { name: "Disable" }).click();
    await expect(row.getByText("Disabled")).toBeVisible();
    await expect(row.getByRole("button", { name: "Enable" })).toBeVisible();
  });

  test("the Owner role can't be edited through the Roles page", async ({
    page,
  }) => {
    await signInAndWait(page, await createAccount("OWNER"));
    await page.goto("/admin/roles");

    const owner = page.getByRole("listitem").filter({
      has: page.getByRole("heading", { name: "Owner (OWNER)" }),
    });

    await owner.getByText("82 permissions").click();

    await expect(owner.getByRole("checkbox")).toHaveCount(0);
    await expect(
      owner.getByRole("button", { name: "Save permissions" }),
    ).toHaveCount(0);
  });

  test("a stale edit reports a conflict rather than overwriting", async ({
    page,
  }) => {
    const server = await createAccount("SERVER");

    await signInAndWait(page, await createAccount("OWNER"));

    const send = () =>
      page.request.patch(`/api/admin/users/${server.id}`, {
        data: { active: false, expectedVersion: server.version },
      });

    expect((await send()).status()).toBe(200);

    const stale = await send();

    expect(stale.status()).toBe(409);
    expect((await stale.json()).error.code).toBe("CONCURRENCY_CONFLICT");
  });
});
