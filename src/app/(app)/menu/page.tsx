import { formatMoney, describeSelection } from "@/components/menu/format";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { getOperationalMenu } from "@/modules/menu/queries/operational-menu";

/** What can be sold here right now: the same data order entry will read. */
export default async function MenuPage() {
  const { location, actor } = await requirePageActor("menu.view");
  const menu = await getOperationalMenu(getDatabase(), actor);

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Menu</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>

      {menu.menus.length === 0 ? (
        <p className="text-neutral-600">No menu is offered at this location right now.</p>
      ) : (
        menu.menus.map((entry) => (
          <section key={entry.id} aria-label={`Menu ${entry.name}`} className="mb-8">
            <h2 className="mb-3 text-xl font-semibold">{entry.name}</h2>
            {entry.categories.length === 0 && (
              <p className="text-neutral-600">Nothing on this menu is for sale yet.</p>
            )}
            {entry.categories.map((category) => (
              <div key={category.id} className="mb-6">
                <h3 className="mb-2 font-semibold">{category.name}</h3>
                <ul className="grid gap-3">
                  {category.items.map((item) => (
                    <li
                      key={item.placementId}
                      aria-label={`Menu item ${item.name}`}
                      className="rounded border border-neutral-200 p-4"
                    >
                      <p className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-medium">{item.name}</span>
                        <span>{formatMoney(item.price)}</span>
                      </p>
                      {item.description && (
                        <p className="text-sm text-neutral-600">{item.description}</p>
                      )}
                      {item.modifierGroups.map((group) => (
                        <div key={group.id} className="mt-3 text-sm">
                          <p className="font-medium">
                            {group.name}{" "}
                            <span className="font-normal text-neutral-600">
                              ({describeSelection(group.minimumSelections, group.maximumSelections)}
                              {group.minimumSelections > 0 ? ", required" : ""})
                            </span>
                          </p>
                          <ul className="ml-4 list-disc">
                            {group.modifiers.map((modifier) => (
                              <li key={modifier.id}>
                                {modifier.name}
                                {modifier.priceAdjustment !== "0.00" &&
                                  ` (${modifier.priceAdjustment.startsWith("-") ? "" : "+"}${formatMoney(modifier.priceAdjustment)})`}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))
      )}
    </>
  );
}
