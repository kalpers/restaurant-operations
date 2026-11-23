# Phase 35 Completion Report: Keyed Gift Card Code Hashes

## Summary

Gift card codes are now stored as a keyed hash: `HMAC-SHA256(GIFT_CARD_CODE_KEY, sha256("gift-card:" + canonical code))`. A copy of the database alone can no longer be used to check guesses of a code. Before this phase, short supplier codes could be guessed offline that way. The key lives outside the database and is read only in `src/config/gift-card-env.ts`. A new `code_hash_scheme` column marks each row `HMAC_SHA256` or `SHA256`.

Rows written before this phase are re-keyed as `HMAC(key, stored hash)`, which needs no code. This runs through `npm run db:rekey-gift-cards` and the hourly maintenance run. Until a row is re-keyed, every code lookup and uniqueness check matches either form. Nothing on screen changes, and no permission or API changes.

Plan: `docs/Phase-35-Keyed-Gift-Card-Code-Hashes.md`. D1–D9 were approved as recommended on 2026-11-23.

## Environment

- Node v26.13.0, npm 12.2.0, Next.js 16.4.5, PostgreSQL 17.11 (Docker Compose)
- Windows 11, PowerShell for test runs

## Policies (as built)

- **Key and production check (D2):**
  - `GIFT_CARD_CODE_KEY` must be 32 or more characters; an empty value counts as unset.
  - `parseEnv` doesn't require it, so `next build` works without it, and the build was verified without it.
  - `instrumentation.ts` calls `getGiftCardCodeKey()` before starting the background runners.
  - A production server without the key answers every request with 500 and logs `GIFT_CARD_CODE_KEY: is required in production`. Next.js keeps the process running after a start-up hook error instead of exiting, so the server serves nothing but stays up. The Phase 22 messaging check behaves the same way.
  - Outside production, a key derived from a fixed label is used.
  - Never rotated. `.env.example` and the cloud guide say to back it up.
- **Hash form and scheme column (D3, D4):**
  - `keyedGiftCardCodeHash(code, key)` = `rekeyLegacyHash(legacyGiftCardCodeHash(code), key)`, giving 64 lowercase hex characters, so the existing check and unique index are unchanged.
  - The rules in `gift-card-code.ts` take the key as an argument and stay pure.
  - `code_hash_scheme` is `SHA256` or `HMAC_SHA256`, not null, checked, with no default.
  - Every write sets `HMAC_SHA256`: sale, stock batch, code replacement, and the retired code on a stock card that gives its code away.
- **Dual lookup (D5):**
  - `codeHashMatches` in `gift-card-ledger.ts` is the one condition. It matches the keyed hash on `HMAC_SHA256` rows and the plain hash on `SHA256` rows.
  - It is used by `findGiftCardIdByCode` (lookup, reload, tender, refund), `lockCardByHash` (stock sale, code replacement), `assertCodeUnused` and the stock batch "already registered" check.
  - Selling a stock card that is still in the old form writes the keyed form, since the code is known at that point.
- **Re-key script and maintenance pass (D6, D7):**
  - `rekeyLegacyGiftCardCodes` (Settlements) works in batches of 500, each its own transaction, using `FOR UPDATE SKIP LOCKED`.
  - It doesn't change the card's `version`, so a screen holding the card sees no conflict. `updated_at` does move, because the ORM sets it on every update.
  - It writes one `settlements.gift-card-codes-rekeyed` audit row (category and actor `SYSTEM`, `cardsRekeyed` count only) per organization in each batch that changed rows, which is one per run for up to 500 cards.
  - `npm run db:rekey-gift-cards` prints counts only. The maintenance result gains `giftCardCodesRekeyed`.
- **Idempotency across the upgrade (D8):** `codeFingerprint` now uses the keyed hash. A code-bearing request retried across the upgrade gets `IDEMPOTENCY_KEY_REUSED` once and nothing runs twice. This is documented in the README.

## Results

- **No row stores the plain SHA-256 of a code after re-keying: PASS.** Covered by an integration test. On the dev database, 16 of 16 cards are `HMAC_SHA256` after the script.
- **Old-form cards keep working before and after re-keying: PASS.** Lookup, reload, tender, and refusal of a reused code at sale and in a stock batch were all tested.
- **Re-keying is repeatable and safe beside a running app: PASS.** The second run reports 0. A card locked by another transaction is skipped without waiting and picked up by the next run.
- **Production refuses to serve without the key, and the build works without it: PASS,** with the Next.js behaviour described under Policies.
- **Codes never appear in audit, logs, outbox or idempotency records: PASS.** A new test also checks that neither hash appears.
- **Canonical Bacon Cheeseburger and idempotent retry unchanged: PASS,** in the full integration suite.

## Architectural decisions

- **A keyed hash, not a per-card salt.** Cards are found by their code alone, so a per-card salt would mean a full scan for every lookup and the loss of the unique index. This follows the existing keyed-hash pattern (`MESSAGING_SUPPRESSION_KEY`, sign-in throttle).
- **Wrapping the old digest** is what lets existing rows be upgraded without their codes. As a result, newly written and re-keyed rows hold exactly the same value.
- **The re-key function lives in Settlements,** which owns gift cards. The maintenance run (infrastructure) calls it, as it already calls Reservations and a workflow.
- **The legacy lookup branch stays in the code.** It matches nothing once every environment is re-keyed, and removing it can be a later cleanup.

## Migrations

- `0080_phase_35_code_hash_scheme.sql`: generated, then adjusted before its first apply. It adds `code_hash_scheme` with a temporary default `SHA256`, so existing rows are marked, then drops the default and adds the check `gift_cards_code_hash_scheme_valid`.
- `npm run db:generate` then reports no changes.
- Applied to the dev database with `npm run db:migrate`.

## Validation results

| Check | Result |
|---|---|
| `npm run lint` | Clean |
| `npm run typecheck` | Clean |
| `npm run test:unit` | 79 files, 1,046 passed |
| `npm run test:integration` | 118 files, 1,592 passed |
| `npm run test:e2e` (CI mode, production build) | 190 passed, 0 flaky, 9.8 min |
| `npm run build` (without `GIFT_CARD_CODE_KEY`) | Clean, 179 pages, no warnings |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm run db:generate` | No schema changes |
| Migration upgrade test (Phase 34 database with a card → 0080) | Pass |
| `npm run db:seed` twice | 0 applied, 33 already applied, both times (no duplicates; 162 permissions, unchanged) |
| `npm run db:rekey-gift-cards` twice on the dev database | 16 re-keyed (1 batch), then 0 |
| `db:reset` safeguards | Existing integration tests pass, unchanged |

Dev-mode E2E wasn't run, because nothing on screen changed. `db:seed:demo` and `db:seed:validation` weren't rerun: they issue cards through the services, which now write the keyed form, and the dev database's demo cards were re-keyed in place.

## Tests executed

- **Unit (+7):**
  - `src/config/gift-card-env.test.ts` (4): production refusal, the fallback, key length, and a production parse without the key.
  - `gift-card-code.test.ts` (3 new, existing tests updated for the key argument): the hash is HMAC over the old SHA-256, a re-keyed legacy hash equals a new hash, and a different key gives a different hash.
  - `gift-card-stock.test.ts` updated.
- **Integration (+7):**
  - `tests/integration/settlements/gift-card-keyed-codes.test.ts` (6): keyed storage for generated, printed and replaced codes; old-form cards working; re-key once and then zero, with the version kept and an audit count with no hashes; skip-locked batching; the maintenance pass; no code or hash in audit, outbox or idempotency records.
  - `tests/integration/database/migrations.test.ts` (1): the upgrade marks existing rows `SHA256`, the column has no default, and a missing or unknown scheme is refused.

## Files changed

- **New:**
  - `src/config/gift-card-env.ts` and its test
  - `src/modules/settlements/services/gift-card-rekey-service.ts`
  - `scripts/rekey-gift-cards.ts`
  - `drizzle/migrations/0080_phase_35_code_hash_scheme.sql` and `meta/0080_snapshot.json`
  - `tests/integration/settlements/gift-card-keyed-codes.test.ts`
  - `docs/Phase-35-Keyed-Gift-Card-Code-Hashes.md` and this report
- **Changed:**
  - Config and start-up: `src/config/env.ts`, `src/instrumentation.ts`
  - Schema: `src/db/schema/gift-cards.ts`
  - Settlements rules: `gift-card-code.ts`, `gift-card-stock.ts` and their tests
  - Settlements services: `gift-card-ledger.ts`, `gift-card-service.ts`, `gift-card-stock-service.ts`
  - Auditing and maintenance: `src/modules/auditing/audit-actions.ts`, `src/infrastructure/maintenance/run-maintenance.ts`
  - Tests and tooling: `tests/integration/database/migrations.test.ts`, `playwright.config.ts` (a key for each CI-mode run), `package.json` (`db:rekey-gift-cards`), `drizzle/migrations/meta/_journal.json`
  - Docs: `.env.example`, `README.md`, `CLAUDE.md`, `docs/Cloud-Deployment-Guide.md`

## Risks

- **Losing the key loses every card.** There is no recovery from the database alone, so the key must be backed up with the other production secrets.
- **The key can't be rotated.** If it leaks, the exposure is back to what it was before this phase. A rotation design would be a later phase.
- **If the database and the key leak together,** short supplier codes can still be guessed offline. The key protects a database leaked on its own, such as a backup, a dump or a read-only breach.
- **Backups taken before re-keying** still hold the plain digests until they expire under the backup retention policy.
- **Until re-keying runs,** old rows stay in the weak form, at most about an hour with the maintenance run on.
- **A code-bearing retry across the upgrade** is refused once (D8).

## Remaining issues

- **CI needs no secret.** `.github/workflows/ci.yml` runs integration tests and the build without the key (fallback, and the build doesn't need it). CI's E2E step gets a fresh key from `playwright.config.ts`.
- **Upgrading an environment:** set `GIFT_CARD_CODE_KEY` before starting the new version, then run `npm run db:rekey-gift-cards`, or let the maintenance run do it.
- **Carried over:** the Phase 22 manual SMTP/Twilio check and the `restaurant-day.spec.ts` dev-mode budget are still with the owner.
- This phase isn't committed yet.

## Next-phase readiness

Phase 35 is complete and validated. No later phase is scheduled. The candidates from the Phase 34 report remain:
- event and private-dining bookings
- FIFO lot costing, which needs a contract rule changed
- opening, closing and side-work checklists
- food-safety temperature logs
- matching supplier invoices against receipts
- prix-fixe and combo items
