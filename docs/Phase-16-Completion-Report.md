# Phase 16 Completion Report

PHASE 16 COMPLETION REPORT. Results are from this repository on 2026-11-10.

## Summary

Phase 16 closes the four gaps named in the plan, adding no restaurant feature and no dependency.

- **Sign-in throttling and lockout.** Failures are counted in PostgreSQL. A known or unknown account locks temporarily, with the identical failure message and timing. An administrator can unlock it.
- **Outbox failure handling.** Failed publishes back off exponentially and dead-letter after 10 attempts. An Admin → System health page shows the outbox and offers an audited retry.
- **Retention.** A maintenance runner (script plus an in-process timer, under an advisory lock) deletes published outbox events after 7 days and expired throttle rows. Idempotency records and all history are kept.
- **Password lifecycle.** Users can change their own password, an administrator can reset one with a one-time temporary password, the user is then forced to change it, and older sessions end after any change.

**Validation:**

| Check | Result |
|---|---|
| lint, typecheck, build | Pass |
| Unit tests | 740 of 740 |
| Integration tests | 1,173 of 1,173 |
| E2E | 134 of 134, with 0 flaky (CI mode, production build) |
| `npm audit --omit=dev` | 0 vulnerabilities |

**First GitHub Actions run.** Before the local E2E run, GitHub Actions failed two specs. Both were test assumptions, fixed and re-verified (see Validation results):

- a hard-coded Owner permission count;
- a dialog helper that didn't expect the reset's second dialog.

**Please review** the three planning amendments (recorded in the plan) and the defaults listed under Architectural decisions.

## Environment

| Component | Version |
|---|---|
| Node.js / npm | 26.13.0 / 12.2.0 |
| Next.js | 16.4.5 |
| next-auth | 4.24.15 (Credentials, JWT sessions) |
| PostgreSQL | 17.11 (Docker) |
| Drizzle ORM / Kit | 0.45.4 / 0.31.11 |
| New dependencies | None |

## Policies (as built)

The plan's Approved Phase 16 Policies 1–23 are binding. README §9 and §23 describe them as built; §33 has a "Phase 16 Hardening" note.

**Amendments decided at planning (2026-11-10):**
1. **System health grants.** No "administrator system role" exists. `admin.system.view` and `admin.system.manage` go to Owner and General Manager. Owner decision.
2. **Audit category.** A new `SYSTEM` audit category is used for `system.outbox-event-retried`. Owner decision.
3. **Outbox delete guard.** The Phase 10 outbox guard refused every DELETE, so retention couldn't run. It now allows deleting published, non-dead-lettered rows only. Required by policy 15.

- **Throttle keys, limits and storage:**
  - *Storage:* `login_throttles` (`key_hash` PK, `failure_count`, `window_started_at`, `locked_until`, `updated_at`).
  - *Keys:* HMAC-SHA256 under `NEXTAUTH_SECRET` of `account:<normalized email>`. When `AUTH_CLIENT_IP_HEADER` is set, also `ip:<rightmost header entry>`. Neither value is stored.
  - *Limits:* 5 failures in 15 minutes lock for 15 minutes; the IP threshold is 50. All are configurable in `src/config/env.ts`.
  - *Counting:* one atomic `INSERT … ON CONFLICT DO UPDATE` per failure, with an injected clock. A failure after the window or the lock has expired starts a new window.
- **Lockout outcome and timing:**
  - *Outcome:* a locked attempt returns the same `null`, so the user sees the same "Invalid email or password".
  - *Timing:* every attempt does the same work: the throttle read and the user lookup in parallel, then one Argon2 verification (dummy while locked). The password is not checked while locked.
  - *Attempts while locked* are not counted, so the lock is not extended.
  - *Audit:* a known account's lock records `auth.account-locked` once, deferred with `after()` like `auth.sign-in-failed`. Unknown emails write nothing.
- **Admin unlock:**
  - *Endpoint:* `POST /api/admin/users/{id}/unlock`.
  - *Checks:* `admin.users.manage`, checked by the guard and again by the service; the target must be at the actor's location; the no-escalation rule applies.
  - *Effects:* deletes the account row and records `auth.account-unlocked`.
  - *UI:* the Users page shows "Locked until …" in the location's time zone, with an Unlock button.
- **Outbox backoff and dead letter:**
  - *Backoff:* `next_attempt_at = now + min(1 s × 2^(n−1), 5 min)`.
  - *Claim filter:* unpublished, not dead-lettered, and due.
  - *Dead letter:* at `OUTBOX_MAX_ATTEMPTS` (10), `failed_at` is set, and an error line with event ID, type and aggregate is logged once.
  - *Ordering:* other rows in the batch keep publishing.
  - *Integrity:* a CHECK forbids a row being both published and dead-lettered, and the unpublished partial index excludes dead-lettered rows.
- **System health page and retry:**
  - *Where:* `/admin/system` (nav "System health") and `GET /api/admin/system/health`, both requiring `admin.system.view`.
  - *Content:* unpublished count, oldest unpublished age, dead-lettered count, and the 50 most recent dead-lettered events. The payload column is never selected.
  - *Retry:* `POST /api/admin/system/outbox/{id}/retry` (`admin.system.manage`) resets `attempts`, `failed_at` and `next_attempt_at`, with `system.outbox-event-retried` (event type, aggregate type and attempts only) in the same transaction.
  - *Scope:* events are scoped to the actor's organization.
- **Retention (what is purged, what is kept):**
  - *Purged:* published, non-dead-lettered outbox events older than `OUTBOX_RETENTION_DAYS` (7), and throttle rows whose window and lock have both expired.
  - *Kept:* unpublished and dead-lettered events (the guard trigger also refuses deleting them), `idempotency_records`, audit events, ledgers, snapshots and all other history.
- **Maintenance runner and lock:**
  - *Function:* `runMaintenance(database, now)` in `src/infrastructure/maintenance/`. It reserves one pooled connection and takes `pg_try_advisory_lock(7316016)`; while another runner holds it, it returns `{ skipped: true }`.
  - *Deletes:* in loops of 1,000 rows per statement, outside any long transaction. It unlocks in `finally`.
  - *How it runs:*
    - `npm run maintenance`, which prints counts only;
    - a timer started in `src/instrumentation.ts` (`MAINTENANCE_INTERVAL_MS`, default one hour, 0 turns it off). Failures are logged with name and code only and never thrown.
- **Password change, reset and forced change:**
  - *Self-service change:*
    - `/account/password` (`POST /api/account/password`), linked from the header, needs no permission.
    - A wrong current password counts toward the lockout and can lock the account. A locked account gets `ACCOUNT_TEMPORARILY_LOCKED`.
    - The new password needs 14 to 1,024 characters and must differ from the current one.
    - Success replaces the hash, sets `password_changed_at`, clears `must_change_password`, bumps `version`, clears the throttle row and records `auth.password-changed`, in one transaction.
  - *Admin reset:*
    - `POST /api/admin/users/{id}/password-reset` requires `admin.users.manage`, the no-escalation rule, the target at the actor's location and `expectedVersion` (409 on mismatch). It refuses the actor's own account.
    - The 16-character temporary password is drawn from a 64-character URL-safe alphabet with `randomBytes` and no modulo bias. It is returned once (`Cache-Control: no-store`) and shown once in a dialog.
    - The reset sets `must_change_password` and `password_changed_at`, clears the lockout and records `admin.user-password-reset` (no details).
  - *Forced change:*
    - `requirePageUser` redirects to `/account/password`. `requireCurrentUser`, which every API guard uses, throws `AuthorizationError` `PASSWORD_CHANGE_REQUIRED` (403).
    - Only the `…AllowingPasswordChange` guard variants used by the change page and endpoint are exempt, plus next-auth's own session and sign-out endpoints, which these guards never wrap.
- **Session invalidation (authTime):**
  - *The claim:* the JWT callback sets `authTime` (milliseconds) only when `user` is present, and carries it unchanged on refresh.
  - *The check:* `getUserAuthContext(…, { session })` rejects `authTime < password_changed_at`, like a disabled user: 401 for APIs, a redirect to `/login` for pages. Pre-Phase-16 tokens have no `authTime`; they stay valid until a change and are rejected after one.
  - *The changer:* after a self-service change, the route sets a fresh next-auth session cookie built with `next-auth/jwt` `encode`. Its `authTime` equals the `password_changed_at` returned by the UPDATE, so app and database clocks can't disagree.
- **Cause of the recurring "Outbox batch failed" log line:**
  - *The order:* Playwright runs `webServer` setup **before** `globalSetup` (confirmed in `playwright/lib/runner/index.js`, `createGlobalSetupTasks`). The server's outbox poller is therefore already connected when global setup runs `DROP DATABASE … WITH (FORCE)` and recreates and migrates the test database.
  - *The evidence:* the log line now carries the SQLSTATE, and every E2E run in this phase showed `errorCode: "42P01"` (undefined table). That is the poller querying the new, still-empty database before migrations finish. The runner then recovers by design.
  - *Decision:* the cause is in the test harness, not application code, so it was recorded and not changed.

## Results

| Check | Result |
|---|---|
| Lockout after threshold, identical failure | PASS |
| Unknown email throttled, no audit | PASS |
| Concurrent failures counted exactly | PASS |
| Admin unlock with escalation rule | PASS |
| Outbox backoff and dead letter | PASS |
| Later events not blocked | PASS |
| Retry audited, no payload exposed | PASS |
| Maintenance purges only eligible rows | PASS |
| Idempotency records untouched | PASS |
| Password change ends older sessions | PASS |
| Admin reset, one-time password never logged | PASS |
| Forced change enforced on pages and APIs | PASS |

## Architectural decisions

- **System health placement.**
  - *Service:* `src/modules/auth/services/system-health-service.ts`, because auth owns the `admin.*` permissions and the admin services. It checks `admin.system.view`/`manage` itself and writes the audit.
  - *Data:* `src/infrastructure/outbox/outbox-health.ts` holds the data functions only. Infrastructure never imports a module.
- **Throttle rules.** Pure rules in `login-throttle-rules.ts` (unit-tested) are mirrored by the single SQL upsert in `login-throttle-repository.ts`. Integration tests check the SQL against the same edges.
- **Raw SQL timestamps.** Raw `sql` parameters pass ISO text with `::timestamptz`, because the driver only serializes `Date` values for typed columns.
- **Password hash reads.** They stay confined to two auth repository queries: sign-in lookup and self-service verification.
- **Service-level permission checks.** `unlockUser` and `resetUserPassword` check `admin.users.manage` themselves, in addition to the route guard.
- **`AuthorizationError`** takes an optional code, for `PASSWORD_CHANGE_REQUIRED`.
- **`/account/password` sits outside the `(app)` route group.** The shell layout's guard redirects forced users there, so putting the page inside the group would loop.
- **Session payload.** It now carries `authTime` as well as `expires` and `user.id`. It is the user's own sign-in instant. The Phase 2 unit test was updated.
- **Maintenance connection.** It reaches the postgres-js pool through drizzle's `$client`, with a narrow type cast, to reserve one connection for the session-level advisory lock.
- **Defaults chosen where the plan was silent:**
  - the IP lock is not audited and not reset on success;
  - user creation and `bootstrap:owner` leave `password_changed_at` null.

### Architecture deviations

| Deviation | Reason |
|---|---|
| Wrong current password returns 422 `CURRENT_PASSWORD_INCORRECT` (`BusinessRuleError`), not 400 | `ValidationError` has a fixed code; the plan's draft said 400 |
| The `SYSTEM` category and the outbox delete guard change | Planning amendments 2 and 3 |

## Migrations

| Migration | Contents |
|---|---|
| `0024_hardening.sql` (generated) | `login_throttles` with CHECKs (count > 0, 64-hex key); `users.must_change_password` (default false), `users.password_changed_at`; `outbox_events.next_attempt_at`, `failed_at`, CHECK `outbox_events_published_or_failed`; unpublished partial index rebuilt (`published_at IS NULL AND failed_at IS NULL`); new partial indexes `outbox_events_failed_idx` (organization, failed_at) and `outbox_events_published_at_idx`; `audit_events_category_valid` replaced to add `SYSTEM` |
| `0025_outbox_retention_guard.sql` (custom) | `CREATE OR REPLACE FUNCTION outbox_events_guard`: DELETE allowed only for published, non-dead-lettered rows; event columns still frozen |

| Check | Result |
|---|---|
| Reconstruction from all migrations | PASS. The integration and E2E setups rebuild the test database from the checked-in migrations; the migration test asserts the exact table list, now including `login_throttles` |
| Upgrade | PASS. A new "upgrades a Phase 15 database" test runs 0000–0023, inserts data, applies the rest, and checks the new columns. It also checks that the guard refuses deleting unpublished and dead-lettered rows and allows a published one, and that the published-or-failed CHECK holds |
| Drift | PASS. `npm run db:generate` reports "No schema changes, nothing to migrate" |
| Dev database | `npm run db:migrate` applied both migrations |

## Validation results

| Step | Result |
|---|---|
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run test:unit` | PASS: 740 tests, 44 files |
| `npm run test:integration` | PASS: 1,173 tests, 68 files (555 s) |
| `npm run test:e2e` | PASS: 134 passed, 0 failed, 0 flaky (`CI=1`, production build). The two specs CI failed on first also passed alone with `--retries=0` (29 of 29 for `auth` plus `hardening`) |
| `npm run build` | PASS. New routes: `/account/password`, `/admin/system`, `/api/account/password`, `/api/admin/system/health`, `/api/admin/system/outbox/[eventId]/retry`, `/api/admin/users/[userId]/password-reset`, `/api/admin/users/[userId]/unlock` |
| `npm audit --omit=dev` | PASS: 0 vulnerabilities |
| `npm audit` | 11 moderate, the same development-only set as Phase 15 (DEV-002/DEV-003). No dependency changed |
| Seed idempotency (dev database) | `db:seed`: "1 applied, 18 already applied", then "0 applied, 19 already applied". 123 permissions, 442 role grants; `admin.system.manage` held by `GENERAL_MANAGER` and `OWNER` only |
| `npm run maintenance` (dev database) | "Maintenance complete: 0 published outbox events and 0 expired sign-in throttles deleted." (counts only), twice |
| `db:reset` safeguards | Refused, exit 1: `NODE_ENV=production`, `NODE_ENV=test`, database `postgres`, an RDS host. No real reset was run on the development database |
| Leak grep | No `writeLog` or `console` call in `src/` or `scripts/` takes a password, email, payload, token or secret. No audit registry field is named for one; the only regex hits were `receiptId` and `tipAmount`. `temporaryPassword` appears only in the reset service's return and the one-time dialog |

### First CI run (GitHub Actions)

The owner reported 2 failed and 132 passed. Both failures came from test assumptions:

1. **`auth.spec.ts` "the Owner role can't be edited through the Roles page"** waited for the text "121 permissions". Phase 16 added two, so the Owner now shows 123. The spec now reads `ALL_PERMISSION_CODES.length`, so a future permission won't break it.
2. **`hardening.spec.ts` "an administrator resets a server's password"** used `confirmDialog`, which waits for no dialog to remain. A reset correctly replaces the confirmation with the one-time password dialog, so one always remains. The spec now confirms by the dialog's accessible name, then checks that the "Temporary password" dialog opens.

These were missed before CI because the local E2E run was blocked: a development server held port 3000.

## Tests executed

- **Unit (740; 32 new or changed):**
  - `login-throttle-rules.test.ts`: window counting, new window after expiry, the 4-versus-5 edge, lock expiry, restart after an expired lock, no row means no lock, HMAC keys, client IP parsing.
  - `outbox-policy.test.ts`: delays for attempts 1–12, the cap for huge counts, the dead-letter boundary.
  - `session-validity.test.ts`: `authTime` before, equal to and after the change; a missing `authTime` with and without a change; temporary passwords (length, alphabet, all 64 characters used, no repeats in 5,000 draws).
  - `env.test.ts`: defaults, an empty header value treated as unset, parsing, and 9 rejections that never echo the value.
  - `auth.test.ts`: token holds `sub` and `authTime` only, `authTime` carried on refresh, pre-Phase-16 tokens, session payload, catalog count 123.
  - `navigation.test.ts`: "System health" in Admin.
- **Integration (1,173; 32 new):**
  - `auth/lockout.test.ts` (11):
    - lockout at 5 with a controlled clock, then expiry;
    - correct password after 4 failures;
    - new window;
    - unknown email locked with no audit;
    - 4 concurrent failures counted as exactly 4;
    - disabled account;
    - deferred failure and lock audits;
    - IP ignored without a configured header;
    - unlock with list display and audit (no email or password);
    - unlock refused without permission, across escalation and at another location.
  - `auth/password-lifecycle.test.ts` (9), driving the real guards with a mocked session:
    - a wrong current password counts toward lockout, and 5 lock it;
    - too-short and unchanged passwords refused;
    - a change replaces the hash, sets `password_changed_at` and the version, audits, and ends older sessions and authTime-less tokens, while the fresh session works;
    - the guard returns 401 and redirects to `/login` for a stale session;
    - a reset returns a one-time password, forces the change, ends sessions and clears the lockout, and the password appears in no audit row or captured console output;
    - forced change gives `PASSWORD_CHANGE_REQUIRED` 403 and a page redirect, while the change guard passes;
    - a reset is refused on self, without permission, across escalation and at another location;
    - a stale version gives a conflict with nothing changed.
  - `infrastructure/outbox-failure.test.ts` (5):
    - backoff timing and no early claim;
    - dead letter at the maximum, never reclaimed;
    - a single error log line without the payload;
    - later and newer events still publish;
    - System health counts and age without payloads, with `admin.system.view` required;
    - retry requires `admin.system.manage`, is audited as SYSTEM without the payload, publishes next and can't run twice;
    - another organization can't see or retry the event.
  - `infrastructure/maintenance.test.ts` (5):
    - skipped while another connection holds the advisory lock;
    - deletes only eligible outbox and throttle rows (batch size 1);
    - a year-old idempotency record is untouched;
    - a second run is idempotent;
    - the lock is released.
  - Updated:
    - migrations: table list and the Phase 15 upgrade;
    - foundation seeds: counts, the seed list and a Phase 15 upgrade of `security.system-permissions`, which grants Owner and GM only, once;
    - seed framework: registry list;
    - permissions: auth context keys include `mustChangePassword`;
    - kitchen lifecycle: a failed event is backed off, then published.
- **E2E (134; 5 new in `tests/e2e/hardening.spec.ts`):**
  - change from the user menu, sign out, new password works and old fails;
  - a change ends another browser's session (redirect to login, 401);
  - admin reset with the one-time dialog and "Must change password", then the server is forced to `/account/password` (page redirect and API 403 `PASSWORD_CHANGE_REQUIRED`), changes it and reaches the Floor;
  - 5 wrong passwords and then the correct one all show "Invalid email or password", the Users page shows "Locked until", and Unlock lets the server in;
  - System health loads for an Owner with no payload in the API, while a Server has no nav link, is sent to `/access-denied` and gets API 403.
  - `restaurant-day.spec.ts` and every existing spec pass.

## Files changed

**New**
- Migrations: `drizzle/migrations/0024_hardening.sql`, `0025_outbox_retention_guard.sql`, `meta/0024_snapshot.json`, `meta/0025_snapshot.json`
- Auth:
  - `src/modules/auth/services/{login-throttle-rules,login-throttle,password-service,session-validity,system-health-service}.ts`, plus unit tests;
  - `src/modules/auth/repositories/login-throttle-repository.ts`;
  - `src/modules/auth/session-cookie.ts`.
- Infrastructure:
  - `src/infrastructure/outbox/{outbox-policy,outbox-health}.ts`, plus a test;
  - `src/infrastructure/maintenance/{run-maintenance,maintenance-runner}.ts`.
- Seed: `src/db/seeds/security-system-permissions.ts`
- Script: `scripts/maintenance.ts`
- Pages and APIs:
  - `src/app/account/password/page.tsx`, `src/app/(app)/admin/system/page.tsx`;
  - `src/app/api/account/password/route.ts`;
  - `src/app/api/admin/system/health/route.ts`, `src/app/api/admin/system/outbox/[eventId]/retry/route.ts`;
  - `src/app/api/admin/users/[userId]/{unlock,password-reset}/route.ts`.
- Components: `src/components/account/change-password-form.tsx`, `src/components/admin/reset-password-button.tsx`
- Tests:
  - `tests/integration/auth/{lockout,password-lifecycle}.test.ts`;
  - `tests/integration/infrastructure/{outbox-failure,maintenance}.test.ts`;
  - `tests/e2e/hardening.spec.ts`.
- Docs: this report

**Modified**
- Schema: `src/db/schema/{auth,infrastructure,auditing}.ts`; migration journal
- Config: `src/config/env.ts` (+ test), `src/config/auth-env.ts`, `.env.example`
- Auth:
  - `auth-options.ts`, `session.ts`, `guards.ts`, `types.ts`, `password.ts`, `permission-catalog.ts`;
  - `credential-service.ts`, `permission-service.ts` (+ test), `user-service.ts`;
  - `user-repository.ts`, `auth-context-repository.ts`, `auth-validators.ts`;
  - `auth.test.ts`.
- Auditing: `audit-actions.ts`
- Outbox and startup: `outbox.ts`, `outbox-runner.ts` (SQLSTATE in the batch-failure log), `src/instrumentation.ts`
- Shared: `src/shared/errors/app-error.ts`
- UI: `src/app/(app)/admin/users/page.tsx`; `app-shell.tsx` ("Change password" link); `navigation.ts` (+ test); `nav-icons.tsx`
- Seeds: `src/db/seeds/registry.ts`; `package.json` (`maintenance` script)
- Tests:
  - integration: `database/{migrations,foundation-seeds,seed-framework}`, `auth/permissions`, `kitchen/lifecycle`;
  - E2E: `auth.spec.ts`.
- Docs:
  - `README.md` §9, §23 and §33 (§36 and `CLAUDE.md` were already updated by the owner);
  - `docs/User-Guide.md`;
  - `docs/Phase-16-Hardening.md` (amendments).

## Risks

1. **Lockout denial of service.** Anyone who knows a staff email can keep that account locked by repeating 5 failures every 15 minutes. Each lock is temporary, and an administrator can unlock it.
2. **The IP key trusts configuration.** Setting `AUTH_CLIENT_IP_HEADER` without a trusted proxy lets clients choose their own key. It is off by default and documented.
3. **Secret rotation resets throttle counters,** as the plan accepts.
4. **Fresh-session cookie duplication.** The self-service change writes the next-auth cookie format itself (name, attributes, `encode`). A next-auth upgrade that changes the format would need this updated. It is isolated in `src/modules/auth/session-cookie.ts`.
5. **Copied tokens.** A copied session token stays usable until a password change, disable or expiry. This is unchanged from Phase 2, and password changes now revoke tokens.
6. **Deferred audit loss.** A deferred lock audit can be lost if the server stops just after responding, as with Audit risk 1.
7. **Wrong-password counts on self-service.** An attacker holding a live session could lock the account by entering wrong current passwords. The lock is temporary.

## Remaining issues

1. **CI on the fixed specs.** GitHub Actions has not run since the two E2E fixes. Locally the full suite passes (134 of 134, 0 flaky).
2. **E2E log line.** The harness ordering behind "Outbox batch failed" (42P01) is left as is. One possible change is to prepare the database in the web server's command before `next start`; that is your decision.
3. **Vitest under Git Bash.** In this environment Vitest fails every file when started from Git Bash ("Cannot read properties of undefined (reading 'config')"), apparently because the drive letter's casing makes it load the runner twice. It runs normally from PowerShell, CI and other terminals.
4. **Carried over:**
   - the stray `%USERPROFILE%\package-lock.json` (the Next build warns about it);
   - the old `restaurant-ops-postgres-1` container;
   - the unanchored `.gitignore` rules;
   - the Phase 6 held-table move gap;
   - DEV-001, DEV-002 and DEV-003 are unchanged;
   - browser-local times in the settlement and notification panels (Phase 15).
5. **Your development server was stopped for the E2E run.** The dev database is migrated and seeded for Phase 16; restart `npm run dev`.

## Next-phase readiness

No Phase 17 is scheduled. Cloud deployment remains on hold by owner decision, and no deployment phase may start without your approval. The hardening in this phase matters for any future deployment: throttling, session revocation, outbox dead-letter visibility and retention. If deployment resumes, `docs/Cloud-Deployment-Guide.md` should mention:
- `AUTH_CLIENT_IP_HEADER` behind the load balancer;
- that `MAINTENANCE_INTERVAL_MS` is safe with several instances (advisory lock).

Phase 16 is complete, subject to your review of this report and a green CI run on the fixed specs.
