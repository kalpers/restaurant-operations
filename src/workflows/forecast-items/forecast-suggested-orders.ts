import type { Database } from "@/db";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import {
  createSuggestedOrders,
  previewSuggestedOrders,
  type SuggestedOrders,
} from "@/modules/inventory/services/suggested-order-service";
import { AuthorizationError } from "@/shared/errors/app-error";

import { computeForecastUsage } from "./forecast-items";

// Phase 25 policies 11 and 13 (D6, D9): suggested orders on the forecast basis. The workflow
// works out the forecast usage and hands it to Inventory, which owns the suggestion, the drafts
// and the stored forecast. `purchasing.manage` is checked before any forecasting work.

function assertCanSuggest(actor: Actor): void {
  if (!actor.permissions.has("purchasing.manage")) {
    throw new AuthorizationError();
  }
}

export async function previewForecastSuggestedOrders(
  executor: DatabaseExecutor,
  actor: Actor,
  input: { throughDate: string; now?: Date },
): Promise<SuggestedOrders> {
  assertCanSuggest(actor);

  const forecast = await computeForecastUsage(executor, {
    organizationId: actor.organizationId,
    locationId: actor.locationId,
    throughDate: input.throughDate,
    now: input.now,
  });

  return previewSuggestedOrders(executor, actor, forecast);
}

export async function createForecastSuggestedOrders(
  database: Database,
  actor: Actor,
  input: { throughDate: string; idempotencyKey: string; now?: Date },
) {
  assertCanSuggest(actor);

  return createSuggestedOrders(database, actor, {
    idempotencyKey: input.idempotencyKey,
    forecast: {
      throughDate: input.throughDate,
      compute: (transaction) =>
        computeForecastUsage(transaction, {
          organizationId: actor.organizationId,
          locationId: actor.locationId,
          throughDate: input.throughDate,
          now: input.now,
        }),
    },
  });
}
