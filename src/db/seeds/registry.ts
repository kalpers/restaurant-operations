import { organizationFoundationSeed } from "./organization-foundation";
import type { Seed } from "./run-seeds";
import { securityFoundationSeed } from "./security-foundation";

/** Seeds run in this order. Later phases register their seeds here. */
export const seeds: readonly Seed[] = [
  organizationFoundationSeed,
  securityFoundationSeed,
];
