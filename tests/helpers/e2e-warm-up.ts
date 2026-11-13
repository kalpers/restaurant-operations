import { join } from "node:path";

import { getEnv } from "../../src/config/env";
import { isCi, loadLocalEnv } from "../../src/config/tooling-env";
import { listAppRoutes } from "../../src/shared/tooling/app-routes";

const CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Playwright global setup (Phase 23). Under `next dev`, each route compiles on its first
 * request, which used to outlast the 5-second assertion waits of whichever test reached it
 * first. Playwright runs this after the web server is up, so every page and API route is
 * requested once here (signed out: pages redirect, APIs answer 401 or 405, and either way
 * the route is compiled) before any test starts. CI serves a production build, which has
 * nothing to compile, so it skips this.
 */
export default async function warmUpDevServer(): Promise<void> {
  if (isCi()) {
    return;
  }

  loadLocalEnv();

  const { APP_BASE_URL: baseUrl } = getEnv();
  const routes = listAppRoutes(join(process.cwd(), "src", "app"));
  const started = Date.now();
  let next = 0;
  let failed = 0;

  const worker = async () => {
    while (next < routes.length) {
      const route = routes[next++]!;

      try {
        const response = await fetch(new URL(route.url, baseUrl), {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        // Read the body so the stream is closed.
        await response.arrayBuffer();
      } catch {
        // A route that fails to answer still compiled or will compile on first use; the
        // test that needs it reports any real problem.
        failed += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(
    `Warmed ${routes.length} routes in ${Math.round((Date.now() - started) / 1000)} s` +
      (failed > 0 ? ` (${failed} did not answer)` : ""),
  );
}
