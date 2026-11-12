import { createHmac } from "node:crypto";

import type { MessageChannel } from "@/infrastructure/messaging/message-sender";

import { normalizeGuestEmail, normalizePhone } from "./guest-contact";

// Phase 22 (policies 4 and 5): the address a message goes to, and the keyed hash the opt-out
// list matches on. SMS needs an E.164 number; email uses the sign-in normalization.

/** Calling codes for the countries a location may be in, keyed by ISO 3166 alpha-2. */
const NATIONAL_NUMBER_RULES: Record<string, { callingCode: string; nationalDigits: number }> = {
  US: { callingCode: "1", nationalDigits: 10 },
  CA: { callingCode: "1", nationalDigits: 10 },
};

/**
 * An E.164 number for texting, or null when the phone can't be turned into one. A number typed
 * with "+" is kept as typed (it has its country code). Otherwise a national number is read with
 * the location's country: for the US and Canada, 10 digits, or 11 starting with 1.
 */
export function toE164(phone: string | null | undefined, country: string): string | null {
  let normalized: string | null;

  try {
    normalized = normalizePhone(phone);
  } catch {
    return null;
  }

  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("+")) {
    return /^\+[1-9][0-9]{6,14}$/.test(normalized) ? normalized : null;
  }

  const rule = NATIONAL_NUMBER_RULES[country.toUpperCase()];

  if (!rule) {
    return null;
  }

  if (normalized.length === rule.nationalDigits) {
    return `+${rule.callingCode}${normalized}`;
  }

  if (normalized.length === rule.nationalDigits + rule.callingCode.length && normalized.startsWith(rule.callingCode)) {
    return `+${normalized}`;
  }

  return null;
}

/** The normalized form an address is matched by: E.164 for SMS, normalized email for EMAIL. */
export function normalizeMessageAddress(channel: MessageChannel, address: string): string | null {
  if (channel === "EMAIL") {
    const email = normalizeGuestEmail(address);

    return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  }

  return /^\+[1-9][0-9]{6,14}$/.test(address) ? address : null;
}

/** HMAC-SHA-256 of channel and normalized address: what the opt-out list stores (D6). */
export function suppressionHash(key: string, channel: MessageChannel, normalizedAddress: string): string {
  return createHmac("sha256", key).update(`${channel}:${normalizedAddress}`).digest("hex");
}
