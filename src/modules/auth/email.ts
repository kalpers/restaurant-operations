/**
 * The one email identity rule: Unicode NFKC, trimmed, lowercase. PostgreSQL's unique
 * constraint on the result is the final guard against duplicate accounts.
 */
export function normalizeEmail(email: string): string {
  return email.normalize("NFKC").trim().toLowerCase();
}
