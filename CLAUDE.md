# Restaurant Operations Management System

Responsive web app for a full-service bar/restaurant (Dining Room, Bar, Takeout). One location now, multi-location-capable data model. Settlement is **recorded only**; no payment processing.

Full domain specs, table lists, status enums and phase policies live in `README.md` (the architecture contract). This file holds the rules and workflow to follow every session. **Before working on a domain, read its section in `README.md`** (e.g. "Domain 10: Orders"). The application is built phase by phase; inspect the repository for what exists today. Phase completion reports go in `docs/` as each phase finishes and must be reviewed before the next phase begins.

`docs/User-Guide.md` describes the operator workflows (reservation -> seating -> order -> kitchen -> settlement -> close -> clean table) as built in an earlier version of this app. Use it as a UX and workflow reference when building those screens, not as a record of existing code. Where it conflicts with `README.md` (for example, it says audit viewing and the Overview dashboard are unimplemented), `README.md` wins: build the audit-viewing capability as specified, and treat the Overview page as a real dashboard unless told otherwise.

The README's per-phase implementation notes (sections 33, Phase 0 through Phase 4) are the **design policies to implement** for those phases, not a description of existing code.

## Stack
Next.js (App Router) + React + TypeScript, Tailwind, PostgreSQL, Drizzle ORM, Zod, Auth.js (Credentials, isolated in the auth module), Playwright, Docker Compose for local Postgres. Architecture: **modular monolith**. No Express server, microservices, Kubernetes, Kafka, Redis, or second database without an explicitly approved architecture change.

## Commands
```
npm ci
cp .env.example .env          # Windows: copy .env.example .env
docker compose up -d          # local PostgreSQL
npm run dev
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration      # uses TEST_DATABASE_URL (isolated *_test DB, recreated each run)
npm run test:e2e              # Playwright, isolated test DB; stop `npm run dev` first
npm run build
npm run db:generate           # generate migration; review before applying
npm run db:migrate
npm run db:seed               # idempotent, keyed via seed_runs
npm run db:reset              # destructive; dev + loopback + DB named restaurant_ops only
npm run bootstrap:owner       # interactive; never pass password as an argument
npm run db:seed:demo          # opt-in demo staff + kitchen; local dev DB only, after bootstrap:owner
npm run db:seed:validation    # opt-in Phase 13 validation fixture; local dev DB only, after bootstrap:owner
```
These scripts are created during the phases that introduce them (lint/typecheck/test/build and `db:generate`/`db:migrate` in Phase 0; `db:seed`/`db:reset` in Phase 1; `bootstrap:owner` in Phase 2). Until then they will not exist. Requires Node 26 (current LTS, pinned in `.nvmrc`; `package.json` `engines` floor is `>=22.12.0`). Never use schema push for persistent environments; commit generated migrations in `drizzle/migrations/`. Never point `TEST_DATABASE_URL` at a shared or production DB.

## Layout and dependency direction
```
src/app, components, config, db, infrastructure, modules, shared, types, workflows
tests/e2e, fixtures, helpers, integration
```
Modules: organization, auth, employees, scheduling, restaurant, reservations, menu, recipes, inventory, orders, kitchen, settlements, auditing, reporting, notifications. Module subfolders (use only when needed, no empty folders): commands, queries, services, repositories, validators, dto, events, errors, types, `index.ts`.

Flow: `UI -> HTTP boundary -> command/query or workflow -> domain service -> repository -> Drizzle -> PostgreSQL`.
- React components never touch Drizzle and hold no business logic. Route handlers stay thin.
- `src/workflows/` only for substantial cross-domain orchestration (submit-order, void-order-item, seat-party, close-order, receive-purchase-order). Ordinary CRUD is not a workflow.
- Env vars are parsed/validated only in `src/config/`; no scattered `process.env`.

## Non-negotiable rules
1. Business logic is organized by domain; domains own their entities' mutation rules.
2. Server-side authorization on every protected request/API. Hidden UI is not authorization. Check **permissions** (`domain.action`), never role names.
3. Employee positions (work performed) and security roles (software permissions) are separate and never synchronized.
4. Historical facts are never recalculated from current config (prices, recipes, compensation, balances). Use immutable snapshots and effective-dated history.
5. Important operational changes run in a PostgreSQL transaction (`withTransaction(database, cb)`; pass the db explicitly). No uncontrolled network calls inside a transaction.
6. Inventory moves only through the Inventory domain. `inventory_transactions` is the authoritative ledger; every mutation writes ledger + balance in one transaction. Reversals are compensating transactions, never erasure. Sign: positive = added, negative = removed.
7. Submitted order items store immutable price, modifier, recipe-ID and consumption snapshots. Submitted items are never silently deleted.
8. Real-time events are emitted only after commit, via the transactional outbox (`outbox_events`).
9. Critical retryable commands (e.g. SEND) take a client idempotency key; a retry reuses the first outcome with zero duplicate tickets, inventory movements, or snapshots.
10. High-contention mutable records use optimistic concurrency (`version`): orders, order_items, schedule_periods, reservations, table_sessions, inventory_counts, employees. Mismatch returns a conflict.
11. Reporting is read-only. Audit records are append-only.
12. Files live outside PostgreSQL (and outside `public/`) behind `FileStorageService`; DB stores metadata and storage reference.
13. One `BusinessDateService` decides business dates (timestamp + location settings, e.g. 4:00 AM cutoff). No module implements its own.
14. Money/costs/quantities are fixed-precision `NUMERIC`, handled as decimal **strings**, never JS `number`: customer money `NUMERIC(12,2)`, costs and inventory quantities `NUMERIC(14,4)`.
15. Never store raw card numbers, CVV, PINs, magnetic-stripe data, bank account or routing numbers. Never log or audit passwords, hashes, tokens, secrets, payment data, or unnecessary HR data.
16. No full offline mode in the POC; implement safe retry and clear connection-status behavior.

## Conventions
- Files `kebab-case.ts`; types/classes `PascalCase`; functions/vars `camelCase`; DB tables/columns `snake_case`.
- Permissions `domain.action` (`orders.submit`, `hr.compensation.view`); events `domain.event-name` (`order.items-submitted`).
- `*_employee_id` = business employee relationship; `*_user_id` = authenticated actor.
- UUID primary keys plus separate human-readable business numbers. `TIMESTAMPTZ` for instants; separate `DATE` for business date. Configurable records are deactivated, not deleted; historical transactions are never deleted.
- Prefer configurable tables (roles, positions, prep stations, categories) and constrained strings over native PG enums for lifecycle states.
- Zod validates request shape only; business rules live in domain services/workflows; PostgreSQL constraints remain the final integrity layer. Unique config codes are org/location-scoped.
- Structured errors: AuthenticationError, AuthorizationError, ValidationError, NotFoundError, ConflictError, BusinessRuleError, ConcurrencyError. Response shape `{ "error": { "code", "message", "requestId" } }`. Never expose SQL, stack traces, or secrets.
- Structured logs (requestId, module, operation, entity ID, severity) are separate from business audit events. Propagate request/correlation IDs.

## Key domain policies (details in README.md)
- **Seating:** orders reference the *table session*, never the physical table. Table condition (CLEAN/DIRTY/OUT_OF_SERVICE) is separate from occupancy, which derives from sessions. Closing an order does not free the table; flow is order closed -> guests leave -> session completed -> DIRTY -> CLEAN. Takeout is never a fake table.
- **Reservations:** reservations do not own sessions; Guest Party is the shared concept. Planning states (`CHECKED_IN`, waitlist `TABLE_ASSIGNED`) never create occupancy. Half-open hold intervals use `reservation_pre_hold_minutes`/`reservation_post_grace_minutes` (default 15/15); planning-conflict and walk-in-protection calculations are distinct. NO_SHOW is manual, CONFIRMED only, at/after post-grace; it never undoes seating. Table combos: max 3 tables, one area.
- **Menu/recipes:** `active` (in catalog) vs `available` (sellable). Recipes are versioned and effective-dated. Free-text instructions never affect inventory; structured modifiers can affect price/inventory/prep. Substitution = multiple ingredient adjustments.
- **Orders:** draft edits consume nothing. SEND is item-level and runs the canonical transaction: validate auth/idempotency/version -> resolve price, modifiers, recipe -> compute consumption -> send batch -> snapshots -> inventory ledger + balance -> kitchen/bar tickets -> histories -> audit -> outbox -> persist idempotency result. Voids: reverse inventory only if never prepared; otherwise inventory stays consumed and waste may be recorded. Discounts/comps do not restore inventory.
- **Kitchen/Bar:** one fulfillment model for both (tickets -> items -> prep station). Item states NEW/PREPARING/READY/COMPLETED/CANCELLED. Order state and fulfillment state are separate.
- **Settlements:** record only. Reconcile exactly to the post-discount, pre-tax order amount (tax deferred). At most one OPEN settlement per order; multiple tenders within it; tips separate and only for CASH/EXTERNAL_CARD; `OTHER` needs a description; zero-amount closure for fully comped orders. A fully reconciled settlement closes the order atomically; CLOSED is terminal. Settlement never changes inventory, fulfillment, or table-session status.
- **Inventory:** creating a PO does not add stock; receiving does (partials supported). Transfers are paired out/in. Weighted-average cost; keep supplier cost history. Counts snapshot system qty and create adjustments on completion.
- **Scheduling:** DRAFT -> PUBLISHED -> ARCHIVED; only drafts directly editable; generation never auto-publishes. One shared eligibility evaluator serves manual assign, generation, fill-open-shifts, and swaps. Availability must cover the whole shift (missing data -> `AVAILABILITY_NOT_CONFIGURED`, ineligible); no manager override. Approved time off is a hard conflict; pending is a score penalty plus warning. Scoring is deterministic (ties: employee number, then UUID). Eligibility and scoring never read compensation or restricted HR data. Published assignments change only via the accepted shift-swap workflow.
- **Auth/HR:** Argon2id hashes; JWT holds only user ID and every protected request re-resolves user, location, roles, and permissions from the DB. No public registration. Emails normalized (NFKC, trim, lowercase); identical failure message for all login failures. HR data is tiered (general / management / restricted) with per-permission APIs. Compensation is effective-dated and never overwritten. Terminating an employee ends eligibility and disables the linked user in one transaction.
- **Compensation:** Pay is owned by the Employee + Position pair (`employee_position_compensation`, effective-dated, `NUMERIC(12,2)` decimal strings), not by the employee alone or the position alone. An employee working several positions has a separate wage for each. Positions hold no wage. Labor cost resolves the wage from the Employee and the Position worked.
- **Reporting (Phase 12):** read-only, permission-controlled, location-aware, business-date-aware, CSV export only. Derive from snapshots, settlement/tender history, ledger history, fulfillment history; never from current config. Indexed aggregation queries first; no materialized views/Redis/warehouse without justification.
- **Notifications:** in-app only (no SMS/email/push).

## Phases
0 Bootstrap, 1 DB foundation, 2 Org+Auth+RBAC, 3 Employees+HR, 4 Scheduling, 5 Restaurant+Seating, 6 Reservations+Waitlist, 7 Menu+Recipes, 8 Inventory+Purchasing, 9 Orders, 10 Kitchen+Bar+Realtime, 11 Settlements, 12 Reporting, 13 Full E2E, 14 Schedule Timeline (read-only Gantt), 15 UI Look and Feel (presentation only, light theme), 16 Hardening (sign-in lockout, outbox dead letter, retention, password lifecycle; not a deployment phase). Cloud deployment is **on hold** by owner decision (2026-11-10): no deployment phase is scheduled, and none may be started without the owner's approval. What a deployment would take on AWS or Azure is described in `docs/Cloud-Deployment-Guide.md`; the app must stay cloud-provider independent. **A phase is finished once `docs/Phase-N-Completion-Report.md` exists; the next phase is the first without one.** Deliverables per phase are in `README.md` section 36. Complete and validate each phase in order before starting the next.

## Working protocol (Claude Code)
1. Identify the requested phase. Implement **only** that phase; do not build future phases.
2. For anything non-trivial, use plan mode first: read the relevant README section, inspect existing code/tests/migrations (once they exist), and present a plan before editing. Starting a phase means planning it in full, then building in small verified steps. Use the Explore subagent for broad codebase searches.
3. Preserve module ownership and dependency direction. Match existing patterns in the codebase before inventing new ones.
4. Schema changes need a generated, reviewed migration. Never hand-edit applied migrations.
5. Put logic in services/commands/workflows, not UI or route handlers. Enforce authorization in each API independently.
6. Add tests: unit for deterministic rules (recipe resolution, modifier adjustment, unit conversion, money, business date, schedule constraints/scoring, settlement balance); integration against PostgreSQL for cross-domain behavior; Playwright for end-to-end workflows.
7. Canonical integration test: Bacon Cheeseburger (Medium, No Onion, Extra Pickles, Swiss instead of American). Assert price, modifier snapshots, recipe ID, kitchen instructions, ingredient resolution, consumption snapshot, exact inventory movement, one fulfillment submission. Retrying with the same idempotency key adds no ticket, inventory transaction, or snapshot.
8. Before declaring done, run lint, typecheck, unit + integration tests, and build (e2e when UI/workflows changed). Fix failures you introduced.
9. Seeds must be idempotent; running twice creates no duplicates.
10. Finish with a summary of files changed, migrations, tests, architectural issues, and remaining work. At phase completion, write `docs/Phase-N-Completion-Report.md` with: Summary, Environment, Policies, Architectural decisions, Migrations, Validation results, Tests executed, Files changed, Risks, Remaining issues, Next-phase readiness.

## Do not
- Replace Drizzle with Prisma, PostgreSQL with another DB, or add a separate API server.
- Merge employee positions with security roles, or check role names instead of permissions.
- Update inventory balances without ledger movement, or drop recipe versioning/snapshots.
- Recalculate history from current configuration.
- Process payments or add card/bank columns.
- Emit real-time events before commit, or skip idempotency on critical commands.
- Redesign the architecture to make implementation easier. **If you find a conflict with this contract, stop and explain it before changing anything.**
- Commit secrets (`NEXTAUTH_SECRET`, `.env`) or force incompatible dependency fixes. `npm audit --omit=dev` must stay clean; if a dev-only advisory has no compatible fix, do not run `npm audit fix --force` or downgrade the Next.js toolchain; propose a risk entry in `docs/accepted-risks.md` (ID, scope, decision, controls, review triggers) and wait for approval before recording it as accepted. Re-run `npm audit` whenever dependencies change. Do not assume any advisory is already accepted.

## Canonical scenario (validate against it)
Manager publishes schedule -> host checks in reservation/walk-in -> waitlist if needed -> seat party (table session) -> server opens order -> drinks sent to Bar -> appetizers sent -> Bacon Cheeseburger with modifiers -> SEND -> snapshot price/modifiers/recipe -> consumption computed once -> ledger + balance atomic -> tickets atomic -> realtime after commit -> kitchen marks READY -> in-app ready notification -> settlement recorded -> order closes -> session completes -> table DIRTY -> CLEAN -> reports and audit reflect it. The same idempotency key sent twice at SEND yields one set of side effects.
