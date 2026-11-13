import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Development tooling only (Phase 23): lists the URLs of every page and API route under
 * `src/app`, so the E2E warm-up can request each once and `next dev` compiles it before
 * the first test needs it. Never imported by the application.
 */

/** Stands in for a dynamic segment: the route compiles, then answers 404 or redirects. */
export const PLACEHOLDER_SEGMENT = "00000000-0000-0000-0000-000000000000";

export type AppRoute = { url: string; kind: "page" | "api" };

/** Turns a route file's directory, relative to `src/app`, into its URL. */
export function routeUrl(directory: string): string {
  const segments = directory
    .split(/[\\/]/)
    .filter((segment) => segment !== "" && !/^\(.*\)$/.test(segment))
    .map((segment) => {
      if (/^\[\[?\.\.\..+\]\]?$/.test(segment)) {
        return "warm-up";
      }

      return /^\[.+\]$/.test(segment) ? PLACEHOLDER_SEGMENT : segment;
    });

  return `/${segments.join("/")}`;
}

/** Every page and API route below `appDirectory`, sorted with pages first. */
export function listAppRoutes(appDirectory: string): AppRoute[] {
  const routes: AppRoute[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        // Private folders (`_name`) never become routes.
        if (!entry.name.startsWith("_")) {
          visit(path);
        }
      } else if (/^page\.(tsx|ts|jsx|js)$/.test(entry.name)) {
        routes.push({ url: routeUrl(relative(appDirectory, directory).split(sep).join("/")), kind: "page" });
      } else if (/^route\.(ts|js)$/.test(entry.name)) {
        routes.push({ url: routeUrl(relative(appDirectory, directory).split(sep).join("/")), kind: "api" });
      }
    }
  };

  visit(appDirectory);

  return routes.sort((a, b) => (a.kind === b.kind ? a.url.localeCompare(b.url) : a.kind === "page" ? -1 : 1));
}
