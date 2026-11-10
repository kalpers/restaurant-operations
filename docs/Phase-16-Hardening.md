# Phase 16: Hardening Design and Implementation Plan

## Purpose

Phase 16 closes four reliability and security gaps found after Phase 15. It adds no new restaurant features.

What the code does today:

- **No sign-in throttling.** `verifyCredentials` (`src/modules/auth/services/credential-service.ts`) checks every attempt with no limit, so a password can be guessed without restriction.
- **Failing outbox events are retried forever.** `processOutboxBatch` (`src/infrastructure/outbox/outbox.ts`) adds one to `attempts` on failure and retries on every batch, with no limit, backoff or dead-letter state. An event that always fails is retried every second indefinitely. Phase 15 also recorded a recurring "Outbox batch failed; it will be retried." log line that was never investigated (Phase 15 Remaining issue 5).
- **No retention.** Published `outbox_events` rows are kept forever. README section 23 says "Outbox retention is an operational task, not built."
- **No password lifecycle.** A password is set only at user creation (`createUserWithRole`) or by `bootstrap:owner`. Nobody can change their own password, an administrator can't reset one, and because the session JWT holds only the user ID, a password change wouldn't end other sessions.

Phase 16 was added by owner decision on 2026-11-10. It is not a deployment phase; cloud deployment stays on hold.

Before implementation:

1. Read `CLAUDE.md` and `README.md`, especially section 9 (Authentication and RBAC), section 20 (Auditing), section 23 (Infrastructure Reliability Tables), section 26 (Error Handling) and section 28 (Logging).
2. Read the Phase 2 plan and completion report (identity, the identical-failure rule, the timing rule for failed sign-ins) and the Audit Domain completion report (audit action registry, allow-listed details).
3. Read `docs/accepted-risks.md`. This phase should add no dependency.

## Approved Phase 16 Policies

### A. Sign-in throttling and lockout

1. **Postgres only.** A new `login_throttles` table holds one row per throttle key: `key_hash` (primary key), `failure_count`, `window_started_at`, `locked_until`, `updated_at`. No Redis and no in-memory counters, so the limit holds across restarts and processes.
2. **Account key.** The key is an HMAC-SHA256 of the normalized email (NFKC, trim, lowercase, through the existing `normalizeEmail`), using the auth secret from `src/config/`. The typed email is never stored. Unknown emails are counted too, so a lockout doesn't reveal whether an account exists. Rotating the secret resets the counters, which is acceptable.
3. **Limits.** These are configured in `src/config/` with these defaults:
   - `AUTH_LOCKOUT_THRESHOLD` = 5 failures;
   - `AUTH_LOCKOUT_WINDOW_MINUTES` = 15;
   - `AUTH_LOCKOUT_DURATION_MINUTES` = 15.

   When the threshold is reached within the window, the key is locked until `now + duration`. Lockout is always temporary. There is no permanent lockout, so an attacker can't permanently disable a real staff member's account.
4. **Optional client-IP key.** When `AUTH_CLIENT_IP_HEADER` is set (for example `x-forwarded-for` behind a trusted proxy), failures are also counted per client IP, with `AUTH_IP_THRESHOLD` (default 50) in the same window. When it isn't set, which is the default, no IP throttling happens, because an untrusted header can be spoofed. The IP is stored only as an HMAC.
5. **Identical outcome.** A locked attempt returns the same `null` and the same "invalid email or password" message as every other failure. It still runs `verifyAgainstDummyHash`, so timing doesn't show the lock. The password is not checked while the key is locked, even if it is correct.
6. **Atomic counting.** Failures are recorded with one upsert (`INSERT … ON CONFLICT DO UPDATE`), which resets the window if it has expired. Two concurrent failures can't both read a stale count.
7. **Success resets.** A successful sign-in deletes the account key's row, in the same transaction that records the login.
8. **Audit.** When a *known* account becomes locked, `auth.account-locked` is recorded (category SECURITY, details: none). Unknown emails write nothing, as Phase 2 already does. The failure audit is deferred in the same way as `auth.sign-in-failed`.
9. **Admin unlock.** A holder of `admin.users.manage` can clear a user's lock from the Users admin page. This records `auth.account-unlocked`. The Users list shows "Locked until …" for a locked account. The existing no-escalation rule applies: the actor must hold every permission the target user holds (`assertActorHolds`).

### B. Outbox failure handling

10. **Backoff.** Add `next_attempt_at TIMESTAMPTZ` and `failed_at TIMESTAMPTZ` to `outbox_events`. A failed publish sets `next_attempt_at = now + min(base × 2^(attempts−1), cap)`, with base 1 s and cap 5 min. The processor claims only rows where `published_at IS NULL AND failed_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now)`. The partial index is rebuilt to match.
11. **Dead letter.** When `attempts` reaches `OUTBOX_MAX_ATTEMPTS` (default 10), `failed_at` is set and the row is never claimed again automatically. A dead-lettered event is logged once at `error` severity, with event ID, type and aggregate only, and never the payload.
12. **Ordering.** Events only mean "refetch" (README section 23), so a backed-off or dead-lettered row doesn't block later events.
13. **Batch failures.** If the batch transaction itself fails, for example the database restarts, the runner keeps its current log-once-per-streak behavior. Phase 16 investigates the recurring E2E log line, records the cause in the completion report, and fixes it if the cause is in application code.
14. **Admin view.** A new page, **Admin → System health**, shows:
    - unpublished count;
    - oldest unpublished age;
    - dead-lettered count;
    - the 50 most recent dead-lettered events (type, aggregate, attempts, last error name, times).

    It never shows payloads. **Retry** clears `failed_at` and `next_attempt_at` and resets `attempts` to 0, and records `system.outbox-event-retried` in the audit log. New permissions: `admin.system.view` and `admin.system.manage`, both granted to Owner and to the existing administrator system role.

### C. Retention

15. **What is purged:**
    - published `outbox_events` older than `OUTBOX_RETENTION_DAYS` (default 7);
    - `login_throttles` rows whose window and lock have both expired.

    Dead-lettered outbox rows are never purged automatically.
16. **What is never purged:** `idempotency_records`. Order send batches, kitchen remakes and settlement tenders reference them with `ON DELETE RESTRICT`, so they are part of the immutable history (rules 7 and 9). Audit events, ledgers, snapshots and all other history are also never touched.
17. **How it runs:** one `runMaintenance(database, now)` function in `src/infrastructure/maintenance/`, which deletes in bounded batches (1,000 rows per statement, looped). It is reachable from:
    - `npm run maintenance`, a new script that prints counts only;
    - an in-process timer started from `src/instrumentation.ts` next to the outbox processor (`MAINTENANCE_INTERVAL_MS`, default one hour, 0 turns it off).

    A Postgres advisory lock (`pg_try_advisory_lock`) makes sure only one runner works at a time. A maintenance failure is logged and never stops the server.

### D. Password lifecycle

18. **New columns on `users`:**
    - `must_change_password BOOLEAN NOT NULL DEFAULT false`;
    - `password_changed_at TIMESTAMPTZ`.
19. **Self-service change.** Any signed-in user can change their own password at `/account/password` (`POST /api/account/password`):
    - **Request:** the current password and the new password.
    - **Checks:** the existing length rules (`MINIMUM_PASSWORD_LENGTH`/`MAXIMUM_PASSWORD_LENGTH`), and the new password must differ from the current one.
    - **Throttling:** a wrong current password counts as a failure for the account's throttle key (policy 3).
    - **Effects:** on success, the Argon2id hash is replaced, `password_changed_at` is set, `must_change_password` is cleared, `version` is incremented, and `auth.password-changed` is recorded, all in one transaction.

    No permission code is needed, because users can only change their own password. The user menu gets a "Change password" link.
20. **Admin reset.**
    - **Endpoint and permission:** `POST /api/admin/users/{userId}/password-reset`, which requires `admin.users.manage` plus the no-escalation rule. Admins can't use it on their own account; they use self-service.
    - **Temporary password:** the server generates a random 16-character password (`crypto.randomBytes`, URL-safe alphabet) and returns it **once** in the response, for the admin to hand over in person. It is never logged, audited or stored except as a hash.
    - **Effects:** sets `must_change_password = true` and `password_changed_at`, clears the account's lockout, and records `admin.user-password-reset` (details: none).
    - **Concurrency:** takes the user's `version` and returns a conflict on mismatch.
21. **Sessions end on a change.**
    - **The claim:** the JWT callback adds `authTime`, the sign-in instant, set only when `user` is present (at sign-in) and carried unchanged on refresh. Next-auth's own `iat` can't be used, because it is reissued on every refresh.
    - **The check:** resolving the auth context rejects a session whose `authTime` is earlier than `password_changed_at`, in the same way it treats a disabled user (signed out, 401 for APIs).
    - **Existing sessions:** tokens issued before Phase 16 have no `authTime`. They stay valid until a password change, and are rejected after one.
    - **The changer's own session:** after a self-service change, the server issues a fresh session.
22. **Forced change.** While `must_change_password` is true:
    - every page guard redirects to `/account/password`;
    - every API guard throws `AuthorizationError` with code `PASSWORD_CHANGE_REQUIRED` (403);
    - the only exceptions are the password-change endpoint, the session endpoint and sign-out.

    The check lives in `src/modules/auth/guards.ts`, so no route can forget it.
23. **No email, no tokens.** No "forgot password" email or reset link is built, because notifications are in-app only. Recovery is admin reset, or `bootstrap:owner` for the last Owner.

### Amendments decided at planning

Decided on 2026-11-10, when `/phase 16` was planned:

1. **System health grants (policy 14).** No "administrator system role" exists; the seeded system roles are Owner, General Manager, Manager, Server, Bartender, Host, Cook, Wait Staff and Inventory Manager. **Owner decision:** `admin.system.view` and `admin.system.manage` go to Owner and General Manager, the two roles that hold `admin.users.manage`.
2. **Audit category for `system.outbox-event-retried`.** The `audit_events_category_valid` CHECK allowed nine categories, none fitting. **Owner decision:** add a `SYSTEM` category; the generated migration replaces the CHECK.
3. **Outbox delete guard (policy 15).** The Phase 10 guard trigger refused every DELETE on `outbox_events`, which would block retention. A custom migration replaces the guard function so it allows deleting a row only when it is published and not dead-lettered. Event columns stay frozen. Recorded rather than asked, because policy 15 requires it.

## 1. Objectives

Deliver:

- `login_throttles`, the throttle service, lockout in `verifyCredentials`, admin unlock and its audit actions
- Outbox backoff, dead letter, the System health admin page and retry
- `runMaintenance`, `npm run maintenance` and the in-process maintenance timer
- Self-service password change, admin reset, forced change and session invalidation
- New permissions in `permission-catalog.ts` and role grants, seeded idempotently
- README and CLAUDE.md updates, a `docs/User-Guide.md` addition, and `docs/Phase-16-Completion-Report.md`

## 2. Scope Boundary

In scope: the four areas above.

Out of scope (don't build):

- Email, SMS or reset links; multi-factor authentication; password-strength scoring libraries
- Purging or changing `idempotency_records`, audit events, ledgers or any other history
- A multi-instance realtime feed (LISTEN/NOTIFY)
- Low-stock alerts, end-of-day close, cash drawer, time zone fixes and the other proposals from the 2026-11-10 robustness list (candidates for later phases)
- Cloud deployment (on hold)

## 3. Review Existing Foundation Before Changes

Confirm, from code rather than memory:

- `verifyCredentials`, `verifyAgainstDummyHash` and `deferFailureAudit`: where the throttle check and failure record fit without changing timing between known and unknown emails.
- How next-auth v4's `authorize` receives the request, and whether headers are available there for the optional IP key.
- `sessionCallbacks`, `getSessionUserId` and `getUserAuthContext`: how `authTime` reaches the context check. Also how the Credentials flow can issue a fresh session after a self-service change. If it can't, the changer is signed out and signs back in; record which.
- `src/modules/auditing/audit-actions.ts`: register every new action with its category, entity type, scope and allow-listed fields.
- `security-rules.ts` (`assertActorHolds`, Owner rules), for unlock and reset.
- The role catalog: which system roles should receive `admin.system.*`.
- The outbox runner, the realtime hub and the E2E cleanup path, for the recurring "Outbox batch failed" line.
- `tests/integration/database/migrations.test.ts`: the new migration must pass the "upgrades a Phase N database" checks.

If any of these conflicts with the policies above, stop and explain before changing it.

## 4. Build Order

Each step leaves lint, typecheck and unit and integration tests green before the next starts.

1. **Migration:** `login_throttles`; `outbox_events.next_attempt_at`, `failed_at` and the rebuilt partial index; `users.must_change_password`, `password_changed_at`. Generated with `npm run db:generate` and reviewed. New permissions seeded.
2. **Throttle and lockout:** service, integration into `verifyCredentials`, audit actions, admin unlock API and UI.
3. **Outbox:** backoff and dead letter in `processOutboxBatch`, investigation of the E2E log line, System health page and retry.
4. **Maintenance:** `runMaintenance`, script, timer and advisory lock.
5. **Password lifecycle:** `authTime` claim and check, self-service change, admin reset, forced-change guards, UI.
6. **E2E, documentation and report.**

## 5. Unit Tests

- *Throttle window:* failure counting inside and outside the window, the threshold edge (4 vs 5), lock expiry, reset on success.
- *Backoff:* the delay for attempts 1–12 (doubling, capped at 5 min) and the dead-letter boundary at `OUTBOX_MAX_ATTEMPTS`.
- *Temporary password generator:* length, alphabet, no repeats across many draws.
- *Session check:* `authTime` before, equal to and after `password_changed_at`; a missing `authTime` with and without a password change.
- *Config:* the new env vars parse with their defaults and reject invalid values.

## 6. Integration Tests

- **Lockout:**
  - 5 bad passwords lock a known account; the correct password then fails with the identical result until the lock expires (controlled clock), then succeeds;
  - an unknown email locks the same way and writes no audit;
  - concurrent failures count exactly;
  - success clears the row;
  - `auth.account-locked` and `auth.account-unlocked` are recorded with no email or password in details;
  - unlock is refused without `admin.users.manage` or across the escalation rule.
- **Outbox:**
  - a publisher that always fails backs off, then dead-letters after the maximum attempts and is no longer claimed;
  - a later event still publishes;
  - retry requeues it and records an audit event;
  - the System health API never returns payloads and requires `admin.system.view` / `admin.system.manage`.
- **Maintenance:**
  - deletes only published outbox rows past retention and expired throttle rows;
  - leaves unpublished, dead-lettered and recent rows, and every `idempotency_records` row;
  - a second concurrent run does nothing (advisory lock).
- **Password lifecycle:**
  - a wrong current password is refused and counted toward lockout;
  - success replaces the hash, sets `password_changed_at`, and an older session is rejected;
  - admin reset returns a one-time password, sets the forced-change flag, never logs or audits it, and is refused on self, without permission, and across the escalation rule;
  - while the forced-change flag is set, a protected API returns `PASSWORD_CHANGE_REQUIRED` and the change endpoint works;
  - a stale `version` on reset returns a conflict.
- **Migrations:** reconstruction from all migrations and the upgrade tests pass.

## 7. E2E Tests (Playwright)

- A user changes their password from the user menu, signs out, and signs in with the new password. The old password fails.
- An admin resets a server's password. The server signs in with the temporary password, is forced to `/account/password`, sets a new one, and reaches the Floor.
- Five wrong passwords show the same error as the first; the admin Users page shows the lock and Unlock clears it.
- The System health page loads for an Owner and is denied for a Server.
- `restaurant-day.spec.ts` and every existing spec still pass.

## 8. Documentation

- **README section 9:** throttling, lockout, password change and reset, forced change, session invalidation.
- **README section 23:** backoff, dead letter, System health, retention (and that idempotency records are kept).
- **README section 33:** a "Phase 16 Hardening" note with the policies as built.
- **README section 36 and the `CLAUDE.md` phase list:** Phase 16 Hardening (done when this plan was written).
- **`.env.example`:** the new variables with their defaults.
- **`docs/User-Guide.md`:** changing a password, admin reset and unlock, System health.

## 9. Validation Checklist

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e` (stop `npm run dev` first)
- [ ] `npm run build`
- [ ] `npm audit --omit=dev` clean (no dependency added)
- [ ] Migration generated, reviewed and committed; `npm run db:generate` then reports no changes
- [ ] Migration reconstruction and upgrade tests pass
- [ ] `npm run db:seed` twice creates no duplicate permissions or grants
- [ ] `npm run maintenance` runs against the dev database and prints counts only
- [ ] `grep` confirms no password, temporary password, email or outbox payload reaches logs or audit details

## 10. Required Phase 16 Completion Report

Write `docs/Phase-16-Completion-Report.md`:

```text
PHASE 16 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / next-auth / PostgreSQL

Policies (as built)
- Throttle keys, limits and storage:
- Lockout outcome and timing:
- Admin unlock:
- Outbox backoff and dead letter:
- System health page and retry:
- Retention (what is purged, what is kept):
- Maintenance runner and lock:
- Password change, reset and forced change:
- Session invalidation (authTime):
- Cause of the recurring "Outbox batch failed" log line:

Results
- Lockout after threshold, identical failure: PASS / FAIL
- Unknown email throttled, no audit: PASS / FAIL
- Concurrent failures counted exactly: PASS / FAIL
- Admin unlock with escalation rule: PASS / FAIL
- Outbox backoff and dead letter: PASS / FAIL
- Later events not blocked: PASS / FAIL
- Retry audited, no payload exposed: PASS / FAIL
- Maintenance purges only eligible rows: PASS / FAIL
- Idempotency records untouched: PASS / FAIL
- Password change ends older sessions: PASS / FAIL
- Admin reset, one-time password never logged: PASS / FAIL
- Forced change enforced on pages and APIs: PASS / FAIL

Architectural decisions
Migrations
Validation results (lint, typecheck, unit, integration, e2e, build, audit)
Tests executed (counts)
Files changed
Risks
Remaining issues
Next-phase readiness
```
