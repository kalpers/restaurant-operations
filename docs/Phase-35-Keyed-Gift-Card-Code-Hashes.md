# Phase 35: Keyed Gift Card Code Hashes Design and Implementation Plan

## Purpose

Owner request, 2026-11-23: deal with the Phase 34 risk "supplier codes are stored as an unsalted SHA-256". A gift card code works like cash. Today `gift_cards.code_hash` is `sha256("gift-card:" + code)`. Anyone holding a copy of the database can hash guesses offline, and a short supplier code (8 characters, Phase 33) can be found that way. App-generated codes (80 random bits) are safe from guessing, but they share the same scheme.

Owner decisions taken before this plan (2026-11-23):

- **A keyed hash, not a per-card salt.** A card is found from its code alone, so a per-card salt would mean hashing every typed code against every card and would lose the unique index. HMAC-SHA256 with a server secret, `GIFT_CARD_CODE_KEY`, kept outside the database (the pattern already used for `MESSAGING_SUPPRESSION_KEY` and the sign-in throttle). Read only in `src/config/`, required in production, a fixed fallback in development and tests, never rotated.
- **Existing cards are re-keyed without knowing their codes.** The stored value becomes `HMAC(key, sha256("gift-card:" + code))`, so an old row is upgraded as `HMAC(key, old code_hash)`. A `code_hash_scheme` column says which form a row holds. A `db:rekey-gift-cards` script upgrades old rows, and lookups accept both forms until that has run.
- **A full phase** with this plan, then a completion report.

What already exists (reviewed 2026-11-23):

| Area | What is there | Where |
|---|---|---|
| Hashing | `hashGiftCardCode(normalized)` = SHA-256 of `gift-card:` + canonical code; `checkSupplierCode` and `generateGiftCardCode` return it | `src/modules/settlements/rules/gift-card-code.ts` |
| Column | `gift_cards.code_hash` text not null, unique index `gift_cards_code_hash_unique`, check `^[0-9a-f]{64}$` | `src/db/schema/gift-cards.ts`, migration 0072 |
| Lookups | `findGiftCardIdByCode` (tenders, refunds, reloads); `lockCardByHash` (stock sale, code replacement); `assertCodeUnused`; stock batch "already registered" check and the unique-violation mapping | `gift-card-ledger.ts`, `gift-card-service.ts`, `gift-card-stock-service.ts` |
| Retired codes | A replaced stock card's row gets `sha256("retired-gift-card:" + card id)`, which can never match a code | `gift-card-service.ts` `retiredCodeHash` |
| Idempotency | `codeFingerprint` puts the code hash inside the request. Only the SHA-256 of the whole canonical request is stored (`request_fingerprint`), never the request | `gift-card-ledger.ts`, `settlement-service.ts`, `src/infrastructure/idempotency/` |
| Keyed-hash pattern | `MESSAGING_SUPPRESSION_KEY`: 32+ characters, optional in `env.ts`, required in production when needed (checked at server start, not in `parseEnv`, because `next build` runs as production), fixed-label fallback outside production | `src/config/env.ts`, `src/config/messaging-env.ts`, `src/instrumentation.ts` |
| Maintenance | Hourly run under an advisory lock, bounded batches | `src/infrastructure/maintenance/run-maintenance.ts` |

Expected change: no new permission, no new screen, one migration (0080, generated then reviewed), one new environment variable, one new script.

## Decisions for the owner

| ID | Question | Recommendation | Reason |
|---|---|---|---|
| D1 | Scope? | **Keyed hashes for gift card codes only:** the key, the scheme column, new and re-keyed hashes, dual lookup, the re-key script, docs. Out: key rotation, keying other hashes (manage-link tokens and idempotency fingerprints stay SHA-256: the tokens have 256 random bits, and the fingerprints are hashes of whole requests), any change to how codes look, are typed or are shown. | The weakness is guessable short codes. Random 256-bit tokens can't be guessed, so keying them adds nothing. |
| D2 | Key settings? | **`GIFT_CARD_CODE_KEY`**, 32+ characters, optional in `env.ts`. **In production the server refuses to start without it** (checked in `instrumentation.ts` with the messaging checks, not in `parseEnv`, so `next build` still works). Outside production a missing key falls back to one derived from a fixed label. A new `src/config/gift-card-env.ts` is the only reader. `.env.example` explains how to generate it and says **never rotate it, and back it up**. | Gift cards can be turned on at any time, so the key must exist before then rather than being required only once a program is enabled. Losing the key makes every code unreadable, which is the same as losing every card. |
| D3 | Hash form? | **`code_hash = HMAC-SHA256(key, sha256("gift-card:" + canonical code))`**, lowercase hex (64 characters, so the existing check stays). The rules stay pure: the key is passed in, never read inside `gift-card-code.ts`. Retired stock rows use the same keyed form over their old label. | Wrapping the existing digest is what lets old rows be upgraded without their codes. One hex format keeps the unique index and check as they are. |
| D4 | Scheme column? | **`code_hash_scheme` text not null, `SHA256` or `HMAC_SHA256` (check constraint), no default.** Migration 0080 adds it as `SHA256` for existing rows, then drops the default, so every new row must name its scheme. A unique index on `code_hash` alone stays (a keyed and an unkeyed hash colliding has negligible odds). | A constrained string, not an enum (project convention). No default, so a code path that forgets the scheme fails instead of quietly writing the weak form. |
| D5 | Lookups while old rows remain? | **Every code lookup and uniqueness check matches `(code_hash = keyed AND scheme = 'HMAC_SHA256') OR (code_hash = legacy AND scheme = 'SHA256')`**, built by one helper in `gift-card-ledger.ts` that the services use. New rows are always written keyed. **The legacy branch stays in the code** (it costs nothing once no rows use it); dropping it is a later cleanup once every environment has re-keyed. | The app keeps working whether or not the script has run, so deploying and re-keying needn't happen at the same moment. |
| D6 | Re-key script? | **`npm run db:rekey-gift-cards`** (`scripts/rekey-gift-cards.ts`), runs on any environment (it isn't destructive): batches of 500, each in its own transaction, rows taken with `FOR UPDATE SKIP LOCKED`, set to `HMAC(key, code_hash)` and `HMAC_SHA256`. Running it again does nothing. It prints counts only and writes one `SYSTEM` audit event per run with the count (`gift-cards.codes-rekeyed`, no hashes). | Safe beside a running app: a card in use mid-sale is skipped and picked up in the next batch or run. The audit row shows when the weak form was removed. |
| D7 | Also re-key in the hourly maintenance run? | **Yes:** the maintenance run calls the same function, so an environment where nobody ran the script still loses the weak hashes within an hour. The script stays for doing it at once (after an upgrade or a restore). | Forgetting the script would otherwise leave guessable hashes in place for good, which is the risk this phase removes. |
| D8 | Idempotency across the upgrade? | **Accept and document it.** A retry of a code-bearing request (gift card tender, sale with a supplier code, stock batch) made before the upgrade and retried after it computes a different fingerprint and gets `IDEMPOTENCY_KEY_REUSED` (409), with nothing done twice. The client retries with a new key. | Retries take seconds and an upgrade is a restart, so the overlap is tiny, and the failure is safe (refused, not duplicated). |
| D9 | Contract wording? | **Update README section 19 (Phase 31 paragraph and the Phase 33 supplier code text), the security section that lists secrets, and the CLAUDE.md gift card line** from "stored only as SHA-256 + last 4" to "stored only as a keyed hash (HMAC-SHA256 with `GIFT_CARD_CODE_KEY`) + last 4". Add Phase 35 to the CLAUDE.md phase list and README sections 33 and 36. `docs/Cloud-Deployment-Guide.md` lists the new secret beside `MESSAGING_SUPPRESSION_KEY`. | The current wording would contradict the code once this is built. |

## Approved Phase 35 Policies

Approved by the owner on 2026-11-23: D1–D9 as recommended. These are binding.

1. **Scope (D1).** Gift card codes only. No key rotation, no keying of manage-link tokens or idempotency fingerprints, no change to how codes look or are shown.
2. **Key (D2).** `GIFT_CARD_CODE_KEY`, 32+ characters, read only in `src/config/gift-card-env.ts`; the production server refuses to start without it (start-up check, not `parseEnv`); a fixed-label fallback outside production; never rotated, backed up.
3. **Hash form (D3).** `HMAC-SHA256(key, sha256("gift-card:" + canonical code))`, 64 lowercase hex; the rules take the key as an argument.
4. **Scheme column (D4).** `code_hash_scheme` `SHA256` | `HMAC_SHA256`, not null, checked, no default; existing rows `SHA256`.
5. **Dual lookup (D5).** Every lookup and uniqueness check accepts both forms through one helper; new rows are always keyed; the legacy branch stays.
6. **Re-key script (D6).** `npm run db:rekey-gift-cards`, batches of 500, `FOR UPDATE SKIP LOCKED`, repeatable, counts only, one `SYSTEM` audit event per run that changed rows.
7. **Maintenance (D7).** The hourly run re-keys leftover rows with the same function.
8. **Idempotency (D8).** A code-bearing retry spanning the upgrade is refused once with `IDEMPOTENCY_KEY_REUSED`; documented.
9. **Wording (D9).** README, CLAUDE.md, `.env.example` and the cloud guide describe the keyed hash and the new secret.

## 1. Objectives

A copy of the database alone no longer lets anyone check guesses of a gift card code. Existing cards keep working throughout, and are upgraded to the keyed form without anyone retyping a code.

## 2. Scope Boundary

In: `GIFT_CARD_CODE_KEY` and its production check; the keyed hash; `code_hash_scheme` (migration 0080); dual lookup in every code lookup and uniqueness check; the re-key function, script and maintenance pass; tests; documentation.

Out: everything listed as out in D1. No screen, permission, ledger, journal, report or API shape changes. Codes still never appear in audit, logs, outbox or idempotency records.

## 3. Review Existing Foundation Before Changes

- `gift-card-code.ts` and its unit tests (`gift-card-code.test.ts`, `gift-card-stock.test.ts`, which assert hashes).
- `gift-card-ledger.ts` (`findGiftCardIdByCode`, `codeFingerprint`), `gift-card-service.ts` (sale, code replacement, `lockCardByHash`, `assertCodeUnused`, `retiredCodeHash`), `gift-card-stock-service.ts` (batch check, unique-violation mapping), `settlement-service.ts` (tender fingerprint).
- `env.ts`, `messaging-env.ts`, `env.test.ts`, `instrumentation.ts` start-up checks.
- `run-maintenance.ts` and its tests; the audit `SYSTEM` category (Phase 16).
- `tests/integration/database/migrations.test.ts` (inserts a raw `code_hash`) and the gift card integration suites.
- Demo and validation seeds (they issue cards through the services, so they pick up the keyed form unchanged).

## 4. Build Order

1. **Config:** `GIFT_CARD_CODE_KEY` in `env.ts`, `src/config/gift-card-env.ts` (key or dev fallback, production refusal), start-up check, `.env.example`.
2. **Rules (pure):** `legacyGiftCardCodeHash(normalized)`, `keyedGiftCardCodeHash(normalized, key)`, `rekeyLegacyHash(legacyHex, key)`; `checkSupplierCode` and `generateGiftCardCode` take the key and return the keyed hash.
3. **Migration 0080** (generated from the schema change, reviewed, then adjusted before first apply to add the column as `SHA256` for existing rows and drop the default): `code_hash_scheme` plus its check.
4. **Lookups:** one `codeHashMatch(normalized)` condition helper; `findGiftCardIdByCode`, `lockCardByHash`, `assertCodeUnused` and the stock batch check use it; every insert or code change writes `HMAC_SHA256`; `codeFingerprint` uses the keyed hash.
5. **Re-key:** `rekeyLegacyGiftCardCodes(database, { batchSize })` in Settlements, the script and `package.json` entry, the maintenance pass, the audit event.
6. Tests (sections 5–7), documentation (section 8), validation (section 9), completion report.

## 5. Unit Tests

- The keyed hash equals `rekeyLegacyHash(legacy hash)` for the same code, so new and re-keyed rows match.
- Different keys give different hashes; the hash is 64 lowercase hex characters.
- `checkSupplierCode` and `generateGiftCardCode` return the keyed hash; the existing canonicalisation tests still pass.
- Config: production without `GIFT_CARD_CODE_KEY` is refused at the start-up check; a key under 32 characters is refused; outside production the fallback is used; `next build`-style production parsing without the key still succeeds.

## 6. Integration Tests

- A card sold, reloaded, tendered, refunded onto, cashed out and replaced after this phase stores `HMAC_SHA256`, and no row holds the plain SHA-256 of its code.
- A card inserted in the old form (`SHA256`, the plain digest) can still be tendered, reloaded and found, and its supplier code is still refused as already used, before re-keying.
- Re-keying turns it into the keyed form; it still works by its code; running again changes nothing; one audit event per run with the count and no hashes.
- Re-keying beside a sale holding the card's row lock skips that row without waiting, and a later run picks it up.
- The maintenance run re-keys leftover rows.
- A stock batch containing a code that matches an old-form card is refused as already registered.
- A row inserted without a scheme is refused by the database (no default); an unknown scheme is refused by the check.
- The migration upgrade test: a database with existing cards before 0080 has every row marked `SHA256` after it.
- Codes still never appear in audit, logs, outbox or idempotency records.
- The canonical Bacon Cheeseburger, including the idempotent retry, passes unchanged.

## 7. E2E Tests (Playwright)

No new spec: nothing on screen changes. The existing gift card specs (sale, tender, stock, unclaimed) must pass unchanged in CI mode.

## 8. Documentation

- README: the gift card paragraphs in section 19 and the Phase 33 supplier code text, the secrets list, Phase 35 entries in sections 33 and 36.
- CLAUDE.md: the gift card policy line (D9) and Phase 35 in the phase list.
- `.env.example` and `docs/Cloud-Deployment-Guide.md`: the new secret, how to generate it, never rotate, back it up, run `db:rekey-gift-cards` after upgrading.
- `docs/Phase-35-Completion-Report.md`.

## 9. Validation Checklist

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e` in CI mode (stop `npm run dev` first)
- [ ] `npm run build`, with no new warnings, and without `GIFT_CARD_CODE_KEY` set
- [ ] `npm audit --omit=dev` clean (no dependency change expected)
- [ ] Migration 0080 reviewed; `npm run db:generate` then reports no changes; migration reconstruction and upgrade tests pass, including an upgrade over a database with existing cards
- [ ] `npm run db:seed` twice creates no duplicates (permission count unchanged, 162); `db:seed:demo` and `db:seed:validation` twice create no duplicates
- [ ] `npm run db:rekey-gift-cards` on the dev database upgrades the demo cards, and a second run reports zero
- [ ] `npm run db:reset` safeguards still refuse a non-dev, non-loopback or wrongly named database
- [ ] Canonical Bacon Cheeseburger, including the idempotent retry, passes unchanged

## 10. Risks

- **Losing the key loses every card.** Codes can't be checked without it, and there is no recovery from the database. The key must be backed up with the other production secrets.
- **The key can't be rotated.** A new key would need every code again. If it leaks, the database alone is back to today's exposure; a rotation design would be a later phase.
- **A leak of both the database and the key** still allows offline guessing of short supplier codes. Keying protects a database leaked alone (backups, dumps, a read-only breach).
- **Until re-keying runs,** old rows keep the weak form (at most an hour with D7).
- **Retries across the upgrade** of code-bearing requests are refused once (D8).
- **Backups taken before re-keying** still hold the plain digests. They follow the backup retention policy.

## 11. Required Phase 35 Completion Report

Write `docs/Phase-35-Completion-Report.md`:

```text
PHASE 35 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL

Policies (as built)
- Key and production check:
- Hash form and scheme column:
- Dual lookup:
- Re-key script and maintenance pass:
- Idempotency across the upgrade:

Results
- No row stores the plain SHA-256 of a code after re-keying: PASS / FAIL
- Old-form cards keep working before and after re-keying: PASS / FAIL
- Re-keying is repeatable and safe beside a running app: PASS / FAIL
- Production refuses to start without the key; build works without it: PASS / FAIL
- Codes never appear in audit, logs, outbox or idempotency records: PASS / FAIL
- Canonical Bacon Cheeseburger and idempotent retry unchanged: PASS / FAIL

Architectural decisions
Migrations
Validation results (lint, typecheck, unit, integration, e2e CI, build, audit)
Tests executed (counts)
Files changed
Risks
Remaining issues
Next-phase readiness
```
