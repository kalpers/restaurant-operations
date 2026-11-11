import { EntityForm } from "@/components/forms/entity-form";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableFrame, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/menu/services/access";
import { getLocationTaxSetting, listTaxCategories, listTaxRates } from "@/modules/menu/services/tax-service";

function formatInstant(value: Date | null): string {
  return value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(value) : "—";
}

/**
 * Admin → Taxes (Phase 17 policy A). Tax categories are organization-wide; rates and the tax
 * switch belong to the current location. A menu item is taxed only through the category
 * assigned to it on its own page.
 */
export default async function TaxesPage() {
  const { actor, location } = await requirePageActor("tax.view");
  const database = getDatabase();
  const [setting, categories, rates] = await Promise.all([
    getLocationTaxSetting(database, actor),
    listTaxCategories(database, actor),
    listTaxRates(database, actor),
  ]);
  const canManage = actorHolds(actor, "tax.manage");

  return (
    <>
      <PageHeader
        title="Taxes"
        description={`Tax categories for the organization, and rates for ${location.locationName}. Tax is added on top of menu prices, on the amount after discounts, and frozen on each item when it is sent.`}
      />

      <div className="grid gap-6">
        <Card aria-label="Tax at this location">
          <CardTitle>Tax at {location.locationName}</CardTitle>
          <p className="mb-3 text-sm text-neutral-700">
            {setting.taxEnabled
              ? "Tax is on. Every item sent must have a tax category with a rate here."
              : "Tax is off. Nothing sent here is taxed."}
          </p>
          {canManage && (
            <EntityForm
              key={`tax-setting-${setting.version}`}
              method="PATCH"
              url="/api/tax/location"
              submitLabel="Save"
              hidden={{ expectedVersion: setting.version }}
              successMessage="Tax setting saved."
              fields={[{ name: "enabled", label: "Charge tax at this location", type: "checkbox", defaultValue: setting.taxEnabled }]}
            />
          )}
        </Card>

        <Card aria-label="Tax categories">
          <CardTitle>Categories and rates</CardTitle>
          {categories.length === 0 ? (
            <EmptyState title="No tax categories yet">Add one below, give it a rate, then assign it to menu items.</EmptyState>
          ) : (
            <div className="grid gap-6">
              {categories.map((category) => {
                const own = rates.filter((rate) => rate.taxCategoryId === category.id);
                const current = own.find((rate) => rate.current);

                return (
                  <section key={category.id} aria-label={`Tax category ${category.code}`} className="grid gap-3 border-t border-neutral-200 pt-4">
                    <h3 className="font-semibold">
                      {category.name} ({category.code}){category.active ? "" : " · inactive"}
                    </h3>
                    <p className="text-sm">
                      Rate here now: <span className="tabular font-medium">{current ? `${current.ratePercent}%` : "none"}</span>
                    </p>
                    {own.length > 0 && (
                      <TableFrame>
                        <Table>
                          <THead>
                            <Tr>
                              <Th>Rate</Th>
                              <Th>From</Th>
                              <Th>Until</Th>
                            </Tr>
                          </THead>
                          <TBody>
                            {own.map((rate) => (
                              <Tr key={rate.id}>
                                <Td className="tabular">{rate.ratePercent}%</Td>
                                <Td>{formatInstant(rate.effectiveFrom)}</Td>
                                <Td>{formatInstant(rate.effectiveTo)}</Td>
                              </Tr>
                            ))}
                          </TBody>
                        </Table>
                      </TableFrame>
                    )}
                    {canManage && (
                      <div className="grid gap-4 sm:grid-cols-2">
                        <EntityForm
                          key={`rate-${category.id}-${current?.id ?? "none"}`}
                          method="POST"
                          url="/api/tax/rates"
                          submitLabel="Set rate"
                          successMessage="Rate saved."
                          hidden={{ taxCategoryId: category.id, expectedCurrentRateId: current?.id ?? null }}
                          fields={[
                            { name: "ratePercent", label: "New rate (%)", required: true },
                            { name: "effectiveFrom", label: "Starting (blank: now)", type: "datetime-local" },
                          ]}
                        />
                        <EntityForm
                          key={`category-${category.id}-${category.version}`}
                          method="PATCH"
                          url={`/api/tax/categories/${category.id}`}
                          submitLabel="Save category"
                          hidden={{ expectedVersion: category.version }}
                          fields={[
                            { name: "name", label: "Name", required: true, defaultValue: category.name },
                            { name: "description", label: "Description", defaultValue: category.description },
                            { name: "active", label: "Active", type: "checkbox", defaultValue: category.active },
                          ]}
                        />
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </Card>

        {canManage && (
          <Card aria-label="Add a tax category">
            <CardTitle>Add a tax category</CardTitle>
            <EntityForm
              method="POST"
              url="/api/tax/categories"
              submitLabel="Add category"
              resetOnSuccess
              successMessage="Tax category added."
              fields={[
                { name: "code", label: "Code (capitals, digits, _)", required: true },
                { name: "name", label: "Name", required: true },
                { name: "description", label: "Description" },
              ]}
            />
          </Card>
        )}
      </div>
    </>
  );
}
