/**
 * Whether a session survives the user's last password change (Phase 16 policy 21). A session
 * signed in before `password_changed_at` is rejected. A token from before Phase 16 has no
 * `authTime`: it stays valid until the first change, and is rejected after one.
 */
export function isSessionCurrent(authTime: number | undefined, passwordChangedAt: Date | null): boolean {
  if (passwordChangedAt === null) {
    return true;
  }

  return authTime !== undefined && authTime >= passwordChangedAt.getTime();
}
