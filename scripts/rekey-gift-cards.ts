import { loadLocalEnv } from "../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../src/db";
import { rekeyLegacyGiftCardCodes } from "../src/modules/settlements/services/gift-card-rekey-service";

// Phase 35 (policy 6): `npm run db:rekey-gift-cards`. Moves gift card code hashes still in the
// plain SHA-256 form to the keyed form (GIFT_CARD_CODE_KEY). Not destructive and safe on any
// environment, beside a running app; running it again reports zero. Prints counts only.

async function main(): Promise<void> {
  loadLocalEnv();

  try {
    const result = await rekeyLegacyGiftCardCodes(getDatabase());

    console.log(`Gift card codes re-keyed: ${result.rekeyed} (${result.batches} batch${result.batches === 1 ? "" : "es"}).`);
  } finally {
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Re-keying failed.");
  process.exitCode = 1;
});
