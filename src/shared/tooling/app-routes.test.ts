import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listAppRoutes, PLACEHOLDER_SEGMENT, routeUrl } from "./app-routes";

describe("routeUrl", () => {
  it("drops route groups", () => {
    expect(routeUrl("(app)/reservations")).toBe("/reservations");
    expect(routeUrl("")).toBe("/");
  });

  it("fills dynamic segments with a placeholder", () => {
    expect(routeUrl("(app)/orders/[orderId]")).toBe(`/orders/${PLACEHOLDER_SEGMENT}`);
    expect(routeUrl("api/reports/[area]/export")).toBe(`/api/reports/${PLACEHOLDER_SEGMENT}/export`);
  });

  it("fills catch-all segments with a word", () => {
    expect(routeUrl("api/auth/[...nextauth]")).toBe("/api/auth/warm-up");
    expect(routeUrl("docs/[[...slug]]")).toBe("/docs/warm-up");
  });
});

describe("listAppRoutes", () => {
  it("finds the app's pages and API routes, pages first", () => {
    const routes = listAppRoutes(join(process.cwd(), "src", "app"));

    expect(routes.some((route) => route.kind === "page" && route.url === "/login")).toBe(true);
    expect(routes.some((route) => route.kind === "api" && route.url === "/api/session/location")).toBe(true);
    expect(routes.findIndex((route) => route.kind === "api")).toBeGreaterThan(
      routes.findLastIndex((route) => route.kind === "page"),
    );
    expect(new Set(routes.map((route) => `${route.kind}:${route.url}`)).size).toBe(routes.length);
  });
});
