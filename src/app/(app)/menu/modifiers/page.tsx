import { ActionButton } from "@/components/forms/action-button";
import { EntityForm, type FormField } from "@/components/forms/entity-form";
import { formatQuantity } from "@/components/inventory/format";
import {
  describeSelection,
  formatMoney,
  PREPARATION_EFFECT_OPTIONS,
  SELECTION_TYPE_OPTIONS,
} from "@/components/menu/format";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import {
  listInventoryItemChoices,
  listUnitPickerChoices,
} from "@/modules/inventory/queries/item-facts";
import { listItems } from "@/modules/menu/services/catalog-service";
import { listModifierEffects } from "@/modules/menu/services/modifier-effect-service";
import { listGroups, listModifiers } from "@/modules/menu/services/modifier-service";

export default async function ModifiersPage() {
  const { location, actor } = await requirePageActor("menu.modifiers.manage");
  const database = getDatabase();
  const [groups, modifiers] = await Promise.all([
    listGroups(database, actor),
    listModifiers(database, actor),
  ]);
  const modifierById = new Map(modifiers.map((modifier) => [modifier.id, modifier]));
  const [menuItems, inventoryChoices, units, effects] = await Promise.all([
    listItems(database, actor),
    listInventoryItemChoices(database, actor.organizationId),
    listUnitPickerChoices(database),
    Promise.all(modifiers.map((modifier) => listModifierEffects(database, actor, modifier.id))),
  ]);
  const effectsOf = new Map(modifiers.map((modifier, index) => [modifier.id, effects[index]!]));
  const unitOptions = [{ value: "", label: "No unit (REMOVE)" }, ...units.map((unit) => ({ value: unit.id, label: unit.code }))];

  const groupFields = (group?: (typeof groups)[number]): FormField[] => [
    { name: "name", label: "Name", required: true, defaultValue: group?.name },
    { name: "description", label: "Description", defaultValue: group?.description },
    {
      name: "selectionType",
      label: "Selection",
      type: "select",
      required: true,
      options: SELECTION_TYPE_OPTIONS,
      defaultValue: group?.selectionType ?? "OPTIONAL_SINGLE",
    },
    { name: "minimumSelections", label: "Minimum selections", type: "number", required: true, defaultValue: group?.minimumSelections ?? 0 },
    { name: "maximumSelections", label: "Maximum selections (blank for no limit)", type: "number", defaultValue: group?.maximumSelections ?? null },
    { name: "displayOrder", label: "Display order", type: "number", defaultValue: group?.displayOrder ?? 0 },
  ];

  const modifierFields = (modifier?: (typeof modifiers)[number]): FormField[] => [
    { name: "name", label: "Name", required: true, defaultValue: modifier?.name },
    { name: "description", label: "Description", defaultValue: modifier?.description },
    { name: "priceAdjustment", label: "Price adjustment", required: true, defaultValue: modifier?.priceAdjustment ?? "0.00" },
    {
      name: "preparationEffectType",
      label: "Preparation effect",
      type: "select",
      options: PREPARATION_EFFECT_OPTIONS,
      defaultValue: modifier?.preparationEffectType ?? "NONE",
    },
    { name: "preparationInstruction", label: "Kitchen instruction", defaultValue: modifier?.preparationInstruction },
  ];

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Modifiers</h1>
      <p className="mb-6 text-neutral-600">{location.locationName}</p>

      <section aria-label="Modifier groups" className="mb-10">
        <h2 className="mb-3 text-xl font-semibold">Modifier groups</h2>
        <div className="mb-4 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
          <h3 className="mb-3 font-semibold">Add a group</h3>
          <EntityForm
            method="POST"
            url="/api/menu/modifier-groups"
            submitLabel="Add group"
            resetOnSuccess
            fields={[{ name: "code", label: "Code (capitals, digits, underscores)", required: true }, ...groupFields()]}
          />
        </div>
        <ul className="grid gap-4">
          {groups.map((group) => (
            <li
              key={group.id}
              aria-label={`Modifier group ${group.code}`}
              className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-4"
            >
              <h3 className="mb-1 font-semibold">
                {group.name}{" "}
                <span className="font-normal text-neutral-600">
                  {group.code} · {describeSelection(group.minimumSelections, group.maximumSelections)}
                  {group.active ? "" : " · Inactive"}
                </span>
              </h3>
              <ul className="mb-3 ml-4 list-disc text-sm">
                {group.modifiers.map((member) => (
                  <li key={member.modifierId}>
                    {modifierById.get(member.modifierId)?.name ?? "Modifier"}
                    {member.active ? "" : " · Inactive in this group"}
                  </li>
                ))}
              </ul>
              <EntityForm
                method="PATCH"
                url={`/api/menu/modifier-groups/${group.id}`}
                submitLabel="Save group"
                hidden={{ expectedVersion: group.version }}
                fields={[
                  ...groupFields(group),
                  { name: "active", label: "Active", type: "checkbox", defaultValue: group.active },
                ]}
              />
              <h4 className="mb-2 mt-4 text-sm font-semibold">Add a modifier to this group</h4>
              <EntityForm
                method="PUT"
                url={`/api/menu/modifier-groups/${group.id}/modifiers`}
                submitLabel="Add to group"
                resetOnSuccess
                fields={[
                  {
                    name: "modifierId",
                    label: "Modifier",
                    type: "select",
                    required: true,
                    options: modifiers
                      .filter((modifier) => modifier.active)
                      .map((modifier) => ({ value: modifier.id, label: modifier.name })),
                  },
                  { name: "displayOrder", label: "Display order", type: "number", defaultValue: 0 },
                  { name: "active", label: "Active in this group", type: "checkbox", defaultValue: true },
                ]}
              />
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Modifiers" className="mb-10">
        <h2 className="mb-3 text-xl font-semibold">Modifiers</h2>
        <div className="mb-4 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
          <h3 className="mb-3 font-semibold">Add a modifier</h3>
          <EntityForm
            method="POST"
            url="/api/menu/modifiers"
            submitLabel="Add modifier"
            resetOnSuccess
            fields={[{ name: "code", label: "Code (capitals, digits, underscores)", required: true }, ...modifierFields()]}
          />
        </div>
        <ul className="grid gap-4">
          {modifiers.map((modifier) => (
            <li
              key={modifier.id}
              aria-label={`Modifier ${modifier.code}`}
              className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-4"
            >
              <h3 className="mb-3 font-semibold">
                {modifier.name}{" "}
                <span className="font-normal text-neutral-600">
                  {modifier.code} · {formatMoney(modifier.priceAdjustment)}
                  {modifier.active ? "" : " · Inactive"}
                </span>
              </h3>
              <EntityForm
                method="PATCH"
                url={`/api/menu/modifiers/${modifier.id}`}
                submitLabel="Save modifier"
                hidden={{ expectedVersion: modifier.version }}
                fields={[
                  ...modifierFields(modifier),
                  { name: "active", label: "Active", type: "checkbox", defaultValue: modifier.active },
                ]}
              />

              <h4 className="mb-1 mt-4 text-sm font-semibold">Inventory effects</h4>
              <p className="mb-2 text-sm text-neutral-600">
                Per menu item. ADD a quantity, REMOVE an ingredient of the item&apos;s recipe, or
                ADJUST it by a signed quantity. Saving an effect doesn&apos;t move stock.
              </p>
              <ul className="mb-3 grid gap-2 text-sm">
                {effectsOf.get(modifier.id)!.map((effect) => (
                  <li key={effect.id} aria-label={`Effect ${effect.effectType} ${effect.inventoryItemName}`} className="flex flex-wrap items-center gap-3">
                    {effect.menuItemName}: {effect.effectType} {effect.inventoryItemName}
                    {effect.quantity !== null && ` ${formatQuantity(effect.quantity)} ${effect.unitCode ?? ""}`}
                    <ActionButton
                      method="DELETE"
                      url={`/api/menu/modifiers/${modifier.id}/effects/${effect.id}`}
                      label="Remove effect"
                      confirm={{ title: "Remove this effect?", body: "Orders already sent keep their snapshot of it." }}
                    />
                  </li>
                ))}
              </ul>
              <EntityForm
                method="POST"
                url={`/api/menu/modifiers/${modifier.id}/effects`}
                submitLabel="Add effect"
                resetOnSuccess
                fields={[
                  { name: "menuItemId", label: "On menu item", type: "select", required: true, options: menuItems.map((item) => ({ value: item.id, label: item.name })) },
                  {
                    name: "effectType",
                    label: "Effect",
                    type: "select",
                    required: true,
                    options: [
                      { value: "ADD", label: "ADD" },
                      { value: "REMOVE", label: "REMOVE" },
                      { value: "ADJUST", label: "ADJUST" },
                    ],
                  },
                  { name: "inventoryItemId", label: "Inventory item", type: "select", required: true, options: inventoryChoices.map((item) => ({ value: item.id, label: item.name })) },
                  { name: "quantity", label: "Quantity (blank for REMOVE; signed for ADJUST)" },
                  { name: "unitOfMeasureId", label: "Unit", type: "select", options: unitOptions, defaultValue: "" },
                ]}
              />
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
