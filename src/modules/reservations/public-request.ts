import { getPublicBookingConfig } from "@/config/messaging-env";
import { clientIpFromHeader } from "@/modules/auth/services/login-throttle-rules";

import type { PublicRequestContext } from "./services/online-booking-service";

/**
 * Phase 22 (policy 10): the client IP for throttling, read only from the trusted proxy header
 * the sign-in setting names. Without one, nothing is read, since the header could be spoofed.
 */
export function publicContextFromHeaders(headers: Pick<Headers, "get">): PublicRequestContext {
  const header = getPublicBookingConfig().clientIpHeader;

  return { clientIp: header ? clientIpFromHeader(headers.get(header) ?? undefined) : null };
}

export function publicRequestContext(request: Request): PublicRequestContext {
  return publicContextFromHeaders(request.headers);
}
