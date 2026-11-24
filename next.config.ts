import { networkInterfaces } from "node:os";

import type { NextConfig } from "next";

/**
 * This machine's own IPv4 addresses. `next dev` refuses its scripts to any host but localhost,
 * so a page opened by IP address (a tablet on the same network) would never become interactive.
 * Read when the server starts; has no effect on a production build.
 */
function ownAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => address.family === "IPv4")
    .map((address) => address.address);
}

const nextConfig: NextConfig = { allowedDevOrigins: ownAddresses() };

export default nextConfig;
