import { EntityForm } from "@/components/forms/entity-form";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableFrame, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/menu/services/access";
import { getLocationTaxSetting, listTaxCategories, listTaxRates } from "@/modules/menu/services/tax-service";
import { getLocationTimeZone } from "@/modules/organization/services/organization-service";
import { formatInstant } from "@/shared/time/format-instant";


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
  const timeZone = await getLocationTimeZone(database, location.locationId);
  const canManage = actorHolds(actor, "tax.manage");

  return (
    <>
      <PageHeader
        title="Taxes"
        description={`Tax categories for the organization, and rates for ${location.locationName}. Each rate is either added on top of menu prices or already included in them; tax is worked out after discounts and frozen on each item when it is sent.`}
      />

      {!canManage && (
        <p role="note" className="mb-4 rounded-md border border-info-300 bg-info-50 p-3 text-sm text-info-800">
          You can view taxes here. Adding categories, setting rates and switching tax on need the
          &ldquo;Manage tax categories, rates and the location tax switch&rdquo; permission, which the Owner and General
          Manager roles have.
        </p>
      )}

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
            <EmptyState title="No tax categories yet">
              {canManage
                ? "Add one under “Add a tax category” below. It then appears here with a form to set its rate. Then assign it to menu items on each item's page."
                : "Someone who manages taxes adds categories and their rates."}
            </EmptyState>
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
                      Rate here now: <span className="tabular font-medium">{current ? `${current.ratePercent}%, ${current.priceIncludesTax ? "already included in menu prices" : "added on top of menu prices"}` : "none"}</span>
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
                                <Td className="tabular">
                                  {rate.ratePercent}% {rate.priceIncludesTax ? "(included in prices)" : "(added on top)"}
                                </Td>
                                <Td>{formatInstant(rate.effectiveFrom, timeZone) || "—"}</Td>
                                <Td>{formatInstant(rate.effectiveTo, timeZone) || "—"}</Td>
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
                            {
                              name: "priceIncludesTax",
                              label:
                                "Menu prices already include this tax (leave off to add tax on top: a $4.50 item at 6% then costs $4.77)",
                              type: "checkbox",
                              defaultValue: current?.priceIncludesTax ?? false,
                            },
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
                { name: "code", label: "Code (letters, digits and _, no spaces; for example FOOD)", required: true },
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
