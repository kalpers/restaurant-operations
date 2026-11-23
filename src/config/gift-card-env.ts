import { createHash } from "node:crypto";

import { EnvValidationError, getEnv, type Env } from "./env";

// Phase 35 (policy 2): the key for gift card code hashes. The rest of the app reads it only
// through here. Checked at server start, not in `parseEnv`: `next build` runs as production
// and must not need the key.

type GiftCardFields = Pick<Env, "NODE_ENV" | "GIFT_CARD_CODE_KEY">;

/** Outside production only: a key derived from a fixed label, so dev and tests need no setup. */
const DEVELOPMENT_KEY = createHash("sha256").update("restaurant-ops-dev-gift-card-code-key").digest("hex");

export function giftCardCodeKeyIssues(env: GiftCardFields): string[] {
  return env.NODE_ENV === "production" && !env.GIFT_CARD_CODE_KEY
    ? ["GIFT_CARD_CODE_KEY: is required in production"]
    : [];
}

/** Throws, naming the variable but never a value, when production has no key. */
export function resolveGiftCardCodeKey(env: GiftCardFields): string {
  const issues = giftCardCodeKeyIssues(env);

  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }

  return env.GIFT_CARD_CODE_KEY ?? DEVELOPMENT_KEY;
}

export function getGiftCardCodeKey(): string {
  return resolveGiftCardCodeKey(getEnv());
}
