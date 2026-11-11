import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { isExclusionViolation, isUniqueViolation } from "@/db/helpers/database-errors";
import { updateVersioned } from "@/db/helpers/versioned-update";
import { locationSettings, menuItems, taxCategories, taxRates } from "@/db/schema";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import { changedFieldNames, recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { compareDecimals, toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { planPriceChange, priceAppliesAt } from "../rules/price-resolution";
import { assertPermission } from "./access";

// Phase 17 tax configuration (approved policies A1-A3, A8). Categories are
// organization-scoped and deactivated, never deleted. Rates are effective-dated per
// Category and Location, changed like menu prices: close the open row, insert a new one.
// Rates and the location switch are managed at the actor's current Location.

export type TaxCategoryInput = { code: string; name: string; description: string | null };

export async function listTaxCategories(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "tax.view");

  return executor
    .select()
    .from(taxCategories)
    .where(eq(taxCategories.organizationId, actor.organizationId))
    .orderBy(asc(taxCategories.code));
}

export async function createTaxCategory(database: Database, actor: Actor, input: TaxCategoryInput) {
  assertPermission(actor, "tax.manage");

  try {
    return await withTransaction(database, async (transaction) => {
      const [row] = await transaction
        .insert(taxCategories)
        .values({ ...input, organizationId: actor.organizationId })
        .returning();

      await recordAudit(transaction, actor, {
        action: "tax.category-created",
        entityId: row!.id,
        after: { code: row!.code, name: row!.name, active: row!.active },
      });

      return row!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("CODE_TAKEN", "Another tax category already uses that code.");
    }

    throw error;
  }
}

export async function updateTaxCategory(
  database: Database,
  actor: Actor,
  categoryId: string,
  input: { name: string; description: string | null; active: boolean; expectedVersion: number },
) {
  assertPermission(actor, "tax.manage");

  const { expectedVersion, ...values } = input;

  return withTransaction(database, async (transaction) => {
    const [before] = await transaction
      .select()
      .from(taxCategories)
      .where(and(eq(taxCategories.id, categoryId), eq(taxCategories.organizationId, actor.organizationId)));
    const updated = await updateVersioned(transaction, taxCategories, {
      id: categoryId,
      organizationId: actor.organizationId,
      expectedVersion,
      values,
      label: "tax category",
    });

    await recordAudit(transaction, actor, {
      action: "tax.category-updated",
      entityId: categoryId,
      before: before ? { code: before.code, name: before.name, active: before.active } : null,
      after: {
        code: updated.code,
        name: updated.name,
        active: updated.active,
        changedFields: before ? changedFieldNames(before, updated, Object.keys(values)) : Object.keys(values),
      },
    });

    return updated;
  });
}

/** The current Location's rates, oldest first per category, with which one is in force. */
export async function listTaxRates(executor: DatabaseExecutor, actor: Actor, now: Date = new Date()) {
  assertPermission(actor, "tax.view");

  const rows = await executor
    .select()
    .from(taxRates)
    .where(and(eq(taxRates.organizationId, actor.organizationId), eq(taxRates.locationId, actor.locationId)))
    .orderBy(asc(taxRates.taxCategoryId), asc(taxRates.effectiveFrom));

  return rows.map((row) => ({ ...row, current: priceAppliesAt({ ...row, price: row.ratePercent }, now) }));
}

/** A rate percentage: 0 to 100 with at most four decimal places. */
export function normalizeTaxRate(value: string): string {
  let rate: string;

  try {
    rate = toScale(value, 4);
  } catch {
    throw new BusinessRuleError("INVALID_TAX_RATE", "A tax rate is a percentage with at most four decimal places.");
  }

  if (compareDecimals(rate, "0") < 0 || compareDecimals(rate, "100") > 0) {
    throw new BusinessRuleError("INVALID_TAX_RATE", "A tax rate is between 0 and 100 percent.");
  }

  return rate;
}

export type ChangeTaxRateInput = {
  taxCategoryId: string;
  ratePercent: string;
  effectiveFrom: Date | null;
  /** The rate row the editor showed as current (null: none); a mismatch is stale. */
  expectedCurrentRateId?: string | null;
};

/** Sets a new rate for one Category at the actor's Location (policy A1). */
export async function changeTaxRate(
  database: Database,
  actor: Actor,
  input: ChangeTaxRateInput,
  now: Date = new Date(),
) {
  assertPermission(actor, "tax.manage");

  const ratePercent = normalizeTaxRate(input.ratePercent);
  const effectiveFrom = input.effectiveFrom ?? now;

  if (effectiveFrom < now) {
    throw new BusinessRuleError("EFFECTIVE_DATE_IN_PAST", "A tax rate can't take effect in the past.");
  }

  try {
    return await withTransaction(database, async (transaction) => {
      // Serialize rate changes per category.
      const [category] = await transaction
        .select({ id: taxCategories.id, code: taxCategories.code })
        .from(taxCategories)
        .where(
          and(eq(taxCategories.id, input.taxCategoryId), eq(taxCategories.organizationId, actor.organizationId)),
        )
        .for("update");

      if (!category) {
        throw new NotFoundError("tax category");
      }

      const scopeRows = (
        await transaction
          .select()
          .from(taxRates)
          .where(and(eq(taxRates.taxCategoryId, category.id), eq(taxRates.locationId, actor.locationId)))
          .orderBy(asc(taxRates.effectiveFrom))
      ).map((row) => ({ ...row, price: row.ratePercent }));

      if (input.expectedCurrentRateId !== undefined) {
        const current = scopeRows.find((row) => priceAppliesAt(row, now));

        if ((current?.id ?? null) !== input.expectedCurrentRateId) {
          throw new ConcurrencyError("tax rate", category.id);
        }
      }

      const plan = planPriceChange(scopeRows, effectiveFrom);

      if ("conflict" in plan) {
        throw new ConflictError(
          plan.conflict === "FUTURE_PRICE_EXISTS" ? "FUTURE_RATE_EXISTS" : "NOT_AFTER_CURRENT",
          plan.conflict === "FUTURE_PRICE_EXISTS"
            ? "A later rate is already scheduled for this category. Review the rate history first."
            : "The new rate must start after the one it replaces.",
        );
      }

      if (plan.close) {
        await transaction
          .update(taxRates)
          .set({ effectiveTo: plan.close.at })
          .where(eq(taxRates.id, scopeRows[plan.close.index]!.id));
      }

      const [created] = await transaction
        .insert(taxRates)
        .values({
          organizationId: actor.organizationId,
          taxCategoryId: category.id,
          locationId: actor.locationId,
          ratePercent,
          effectiveFrom,
          createdByUserId: actor.userId,
        })
        .returning();
      const replaced = plan.close ? scopeRows[plan.close.index] : undefined;

      await recordAudit(transaction, actor, {
        action: "tax.rate-changed",
        entityId: category.id,
        before: replaced
          ? { categoryCode: category.code, recordId: replaced.id, percent: replaced.ratePercent, effectiveFrom: replaced.effectiveFrom }
          : null,
        after: { categoryCode: category.code, recordId: created!.id, percent: ratePercent, effectiveFrom },
      });

      return created!;
    });
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw new ConflictError("TAX_RATE_OVERLAP", "That rate overlaps another rate for this category.");
    }

    throw error;
  }
}

/** Whether the actor's Location taxes orders, with the settings version for an edit. */
export async function getLocationTaxSetting(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "tax.view");

  const [row] = await executor
    .select({ taxEnabled: locationSettings.taxEnabled, version: locationSettings.version })
    .from(locationSettings)
    .where(eq(locationSettings.locationId, actor.locationId));

  if (!row) {
    throw new NotFoundError("location");
  }

  return row;
}

/** Turns tax on or off for the actor's Location (policy A3). Audited. */
export async function setLocationTaxEnabled(
  database: Database,
  actor: Actor,
  input: { enabled: boolean; expectedVersion: number },
) {
  assertPermission(actor, "tax.manage");

  return withTransaction(database, async (transaction) => {
    const [updated] = await transaction
      .update(locationSettings)
      .set({ taxEnabled: input.enabled, version: sql`${locationSettings.version} + 1`, updatedAt: new Date() })
      .where(
        and(eq(locationSettings.locationId, actor.locationId), eq(locationSettings.version, input.expectedVersion)),
      )
      .returning({ taxEnabled: locationSettings.taxEnabled, version: locationSettings.version });

    if (!updated) {
      throw new ConcurrencyError("location settings", actor.locationId);
    }

    await recordAudit(transaction, actor, {
      action: "tax.location-setting-changed",
      entityId: actor.locationId,
      after: { enabled: updated.taxEnabled },
    });

    return updated;
  });
}

/** An assignable Tax Category: in the organization and active, or not found. */
export async function resolveAssignableTaxCategory(
  executor: DatabaseExecutor,
  organizationId: string,
  categoryId: string,
): Promise<void> {
  const [row] = await executor
    .select({ id: taxCategories.id })
    .from(taxCategories)
    .where(
      and(
        eq(taxCategories.id, categoryId),
        eq(taxCategories.organizationId, organizationId),
        eq(taxCategories.active, true),
      ),
    );

  if (!row) {
    throw new NotFoundError("tax category");
  }
}

export type ItemTax = { taxCategoryId: string; taxCategoryCode: string; taxRate: string };

/**
 * The trusted lookup SEND uses (policy A4): each menu item's Tax Category and the rate in
 * force for it at the Location at `at`. An item with no category, or whose category has
 * no rate in force, maps to null; the caller decides whether that is refused.
 */
export async function resolveItemTaxes(
  executor: DatabaseExecutor,
  organizationId: string,
  locationId: string,
  menuItemIds: readonly string[],
  at: Date,
): Promise<Map<string, ItemTax | null>> {
  const result = new Map<string, ItemTax | null>();

  if (menuItemIds.length === 0) {
    return result;
  }

  const items = await executor
    .select({ id: menuItems.id, taxCategoryId: menuItems.taxCategoryId, code: taxCategories.code })
    .from(menuItems)
    .leftJoin(taxCategories, eq(taxCategories.id, menuItems.taxCategoryId))
    .where(and(eq(menuItems.organizationId, organizationId), inArray(menuItems.id, [...menuItemIds])));
  const categoryIds = [...new Set(items.flatMap((item) => (item.taxCategoryId ? [item.taxCategoryId] : [])))];
  const rates =
    categoryIds.length === 0
      ? []
      : await executor
          .select()
          .from(taxRates)
          .where(and(eq(taxRates.locationId, locationId), inArray(taxRates.taxCategoryId, categoryIds)));

  for (const item of items) {
    const rate =
      item.taxCategoryId === null
        ? undefined
        : rates.find(
            (row) =>
              row.taxCategoryId === item.taxCategoryId && priceAppliesAt({ ...row, price: row.ratePercent }, at),
          );

    result.set(
      item.id,
      rate && item.code ? { taxCategoryId: rate.taxCategoryId, taxCategoryCode: item.code, taxRate: rate.ratePercent } : null,
    );
  }

  return result;
}
