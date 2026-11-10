import { and, asc, eq, isNull, or } from "drizzle-orm";

import type { Database } from "@/db";
import { isExclusionViolation } from "@/db/helpers/database-errors";
import { locations, menuItemPrices, menuItems } from "@/db/schema";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { isPositiveDecimal, toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import {
  planPriceChange,
  priceAppliesAt,
  resolvePrice,
  type PriceRow,
  type ResolvedPrice,
} from "../rules/price-resolution";
import { assertPermission, requireMenuItem } from "./access";

async function readPriceRows(
  executor: DatabaseExecutor,
  menuItemId: string,
  locationId: string | null,
) {
  return executor
    .select()
    .from(menuItemPrices)
    .where(
      and(
        eq(menuItemPrices.menuItemId, menuItemId),
        locationId === null
          ? isNull(menuItemPrices.locationId)
          : or(isNull(menuItemPrices.locationId), eq(menuItemPrices.locationId, locationId)),
      ),
    )
    .orderBy(asc(menuItemPrices.effectiveFrom));
}

/**
 * The one authoritative price lookup: the location price in force at `at`, else the
 * organization default, else null. Orders ask this, never the raw price rows. The
 * organization is checked, so an item ID from another tenant resolves to nothing.
 */
export async function resolveMenuItemPrice(
  executor: DatabaseExecutor,
  organizationId: string,
  menuItemId: string,
  locationId: string,
  at: Date,
): Promise<ResolvedPrice | null> {
  const [item] = await executor
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(and(eq(menuItems.id, menuItemId), eq(menuItems.organizationId, organizationId)));

  if (!item) {
    return null;
  }

  const rows = await readPriceRows(executor, menuItemId, locationId);

  return resolvePrice(rows, locationId, at);
}

/** Price history for an item, newest first within each scope. Needs pricing view. */
export async function listPriceHistory(
  executor: DatabaseExecutor,
  actor: Actor,
  menuItemId: string,
  now: Date = new Date(),
) {
  assertPermission(actor, "menu.pricing.view");
  await requireMenuItem(executor, actor, menuItemId);

  const rows = await executor
    .select()
    .from(menuItemPrices)
    .where(eq(menuItemPrices.menuItemId, menuItemId))
    .orderBy(asc(menuItemPrices.locationId), asc(menuItemPrices.effectiveFrom));

  return rows.map((row) => ({ ...row, current: priceAppliesAt(row, now) }));
}

function normalizePrice(value: string): string {
  let price: string;

  try {
    price = toScale(value, 2);
  } catch {
    throw new BusinessRuleError(
      "INVALID_PRICE",
      "A price is a number with at most two decimal places.",
    );
  }

  if (price.startsWith("-") || (!isPositiveDecimal(price) && price !== "0.00")) {
    throw new BusinessRuleError("INVALID_PRICE", "A price can't be negative.");
  }

  return price;
}

export type ChangePriceInput = {
  locationId: string | null;
  price: string;
  effectiveFrom: Date | null;
  /**
   * The price row the editor showed as current for this scope (null: none). If another
   * change got in first, this no longer matches and the change is refused as stale.
   */
  expectedCurrentPriceId?: string | null;
};

/**
 * Sets a new price for one scope. The price in force is closed where the new one starts
 * and a new row is inserted, in one transaction; history is never rewritten.
 */
export async function changePrice(
  database: Database,
  actor: Actor,
  menuItemId: string,
  input: ChangePriceInput,
  now: Date = new Date(),
) {
  assertPermission(actor, "menu.pricing.edit");

  const price = normalizePrice(input.price);
  const effectiveFrom = input.effectiveFrom ?? now;

  if (effectiveFrom < now) {
    throw new BusinessRuleError(
      "EFFECTIVE_DATE_IN_PAST",
      "A price can't take effect in the past.",
    );
  }

  try {
    return await withTransaction(database, async (transaction) => {
      // Serialize price changes per item, so two editors can't interleave.
      const [item] = await transaction
        .select({ id: menuItems.id })
        .from(menuItems)
        .where(
          and(
            eq(menuItems.id, menuItemId),
            eq(menuItems.organizationId, actor.organizationId),
          ),
        )
        .for("update");

      if (!item) {
        throw new NotFoundError("menu item");
      }

      if (input.locationId !== null) {
        const [location] = await transaction
          .select({ id: locations.id })
          .from(locations)
          .where(
            and(
              eq(locations.id, input.locationId),
              eq(locations.organizationId, actor.organizationId),
            ),
          );

        if (!location) {
          throw new NotFoundError("location");
        }
      }

      const scopeRows = (
        await transaction
          .select()
          .from(menuItemPrices)
          .where(
            and(
              eq(menuItemPrices.menuItemId, menuItemId),
              input.locationId === null
                ? isNull(menuItemPrices.locationId)
                : eq(menuItemPrices.locationId, input.locationId),
            ),
          )
          .orderBy(asc(menuItemPrices.effectiveFrom))
      ).map((row) => ({ ...row, locationId: row.locationId }) satisfies PriceRow & { id: string });

      if (input.expectedCurrentPriceId !== undefined) {
        const current = scopeRows.find((row) => priceAppliesAt(row, now));

        if ((current?.id ?? null) !== input.expectedCurrentPriceId) {
          throw new ConcurrencyError("price", menuItemId);
        }
      }

      const plan = planPriceChange(scopeRows, effectiveFrom);

      if ("conflict" in plan) {
        throw new ConflictError(
          plan.conflict,
          plan.conflict === "FUTURE_PRICE_EXISTS"
            ? "A later price is already scheduled for this item. Review the price history first."
            : "The new price must start after the one it replaces.",
        );
      }

      if (plan.close) {
        await transaction
          .update(menuItemPrices)
          .set({ effectiveTo: plan.close.at })
          .where(eq(menuItemPrices.id, scopeRows[plan.close.index]!.id));
      }

      const [created] = await transaction
        .insert(menuItemPrices)
        .values({
          organizationId: actor.organizationId,
          menuItemId,
          locationId: input.locationId,
          price,
          effectiveFrom,
          createdByUserId: actor.userId,
        })
        .returning();
      const replaced = plan.close ? scopeRows[plan.close.index] : undefined;

      await recordAudit(transaction, actor, {
        action: "menu.price-changed",
        entityId: menuItemId,
        before: replaced ? { priceId: replaced.id, price: replaced.price, effectiveFrom: replaced.effectiveFrom } : null,
        after: { priceId: created!.id, price, effectiveFrom },
      });

      return created!;
    });
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw new ConflictError(
        "PRICE_OVERLAP",
        "That price overlaps another price for this item.",
      );
    }

    throw error;
  }
}
