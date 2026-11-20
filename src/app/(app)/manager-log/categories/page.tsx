import Link from "next/link";

import { EntityForm } from "@/components/forms/entity-form";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listLogCategories } from "@/modules/restaurant/services/manager-log-category-service";

/**
 * Phase 33 (policies 17–18): the organization's manager log categories. Added, renamed,
 * reordered and deactivated, never deleted; an entry keeps its category whatever happens.
 */
export default async function ManagerLogCategoriesPage() {
  const { actor } = await requirePageActor("manager-log.categories");
  const categories = await listLogCategories(getDatabase(), actor);

  return (
    <>
      <PageHeader
        title="Manager log categories"
        description="The categories managers choose from at every location. A deactivated category stays on the entries that use it but can't be chosen for new ones."
        breadcrumbs={[{ label: "Manager log", href: "/manager-log" }, { label: "Categories" }]}
      />
      <Card className="mb-6">
        <h2 className="mb-3 text-lg font-semibold">Add a category</h2>
        <EntityForm
          method="POST"
          url="/api/manager-log/categories"
          submitLabel="Add category"
          successMessage="Category added."
          resetOnSuccess
          fields={[
            { name: "name", label: "Name", required: true },
            { name: "sortOrder", label: "Order (optional)", type: "number" },
          ]}
        />
      </Card>
      <ol className="grid gap-3" aria-label="Manager log categories">
        {categories.map((category) => (
          <li key={category.id}>
            <Card className="grid gap-3" aria-label={category.name}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{category.name}</span>
                <span className="text-sm text-neutral-600">{category.code}</span>
                {!category.active && <Badge tone="neutral">Inactive</Badge>}
              </div>
              <EntityForm
                method="PATCH"
                url={`/api/manager-log/categories/${category.id}`}
                submitLabel="Save"
                successMessage="Category saved."
                hidden={{ expectedVersion: category.version }}
                fields={[
                  { name: "name", label: "Name", required: true, defaultValue: category.name },
                  { name: "sortOrder", label: "Order", type: "number", required: true, defaultValue: category.sortOrder },
                  { name: "active", label: "Active", type: "checkbox", defaultValue: category.active },
                ]}
              />
            </Card>
          </li>
        ))}
      </ol>
      <p className="mt-6 text-sm">
        <Link href="/manager-log" className="underline">
          Back to the manager log
        </Link>
      </p>
    </>
  );
}
