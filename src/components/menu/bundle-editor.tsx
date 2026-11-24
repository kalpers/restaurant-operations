"use client";

import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { sendApiRequest, type ApiFailure } from "@/components/forms/api-request";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldHint, Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import type { BundleConfiguration } from "@/modules/menu/services/bundle-service";

type Failure = Pick<ApiFailure, "code" | "message" | "requestId">;
type OptionDraft = { componentMenuItemId: string; upcharge: string };
type SlotDraft = { key: string; id: string | null; name: string; defaultCourse: number; minimumChoices: number; maximumChoices: number; options: OptionDraft[] };

const fromConfig = (config: BundleConfiguration): SlotDraft[] =>
  config.slots.map((slot) => ({
    key: slot.id,
    id: slot.id,
    name: slot.name,
    defaultCourse: slot.defaultCourse,
    minimumChoices: slot.minimumChoices,
    maximumChoices: slot.maximumChoices,
    options: slot.options.map((option) => ({ componentMenuItemId: option.componentMenuItemId, upcharge: option.upcharge })),
  }));

const blankSlot = (): SlotDraft => ({
  key: crypto.randomUUID(),
  id: null,
  name: "",
  defaultCourse: 1,
  minimumChoices: 1,
  maximumChoices: 1,
  options: [],
});

/**
 * Phase 36 (policy 9): makes an item a prix-fixe or combo: one price (set under Pricing), and
 * courses each offering ordinary menu items, optionally with an upcharge. A bundle has no recipe,
 * routing or modifiers of its own; its choices bring theirs.
 */
export function BundleEditor({
  itemId,
  itemVersion,
  config,
  components,
  canEdit,
}: {
  itemId: string;
  itemVersion: number;
  config: BundleConfiguration;
  components: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [slots, setSlots] = useState<SlotDraft[]>(() => (config.itemKind === "BUNDLE" ? fromConfig(config) : []));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const nameOf = new Map(components.map((component) => [component.id, component.name]));

  const update = (key: string, change: Partial<SlotDraft>) =>
    setSlots((current) => current.map((slot) => (slot.key === key ? { ...slot, ...change } : slot)));

  async function save() {
    setPending(true);
    setError(null);

    const result = await sendApiRequest("PUT", `/api/menu/items/${itemId}/bundle`, {
      expectedVersion: itemVersion,
      slots: slots.map(({ id, name, defaultCourse, minimumChoices, maximumChoices, options }) => ({
        id,
        name,
        defaultCourse,
        minimumChoices,
        maximumChoices,
        options: options.map((option) => ({ componentMenuItemId: option.componentMenuItemId, upcharge: option.upcharge || "0" })),
      })),
    });

    setPending(false);

    if (result.ok) {
      toast.success("Bundle saved.");
      router.refresh();
    } else {
      setError(result);
    }
  }

  async function clear() {
    setPending(true);
    setError(null);

    const result = await sendApiRequest("POST", `/api/menu/items/${itemId}/bundle/clear`, { expectedVersion: itemVersion });

    setPending(false);

    if (result.ok) {
      toast.success("This item is an ordinary item again.");
      setSlots([]);
      router.refresh();
    } else {
      setError(result);
    }
  }

  if (!canEdit) {
    return config.itemKind === "BUNDLE" ? (
      <ul className="grid gap-1 text-sm">
        {config.slots.map((slot) => (
          <li key={slot.id}>
            <strong>{slot.name}</strong>: {slot.options.map((option) => option.name).join(", ")}
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-sm text-neutral-700">An ordinary item.</p>
    );
  }

  return (
    <div className="grid gap-3">
      {slots.length === 0 && (
        <p className="text-sm text-neutral-700">
          An ordinary item. Add a course to make it a prix-fixe or combo: one price, with the guest choosing from each course.
        </p>
      )}
      {slots.map((slot, index) => (
        <Card key={slot.key} className="grid gap-2" data-testid="bundle-course">
          <div className="grid gap-2 sm:grid-cols-[1fr_6rem_6rem_6rem_auto]">
            <Field label={`Course ${index + 1} name`}>
              <Input value={slot.name} maxLength={60} onChange={(event) => update(slot.key, { name: event.target.value })} />
            </Field>
            <Field label="Sent as course">
              <Input type="number" min={1} max={5} value={slot.defaultCourse} onChange={(event) => update(slot.key, { defaultCourse: Number(event.target.value) })} />
            </Field>
            <Field label="Choose at least">
              <Input type="number" min={0} max={10} value={slot.minimumChoices} onChange={(event) => update(slot.key, { minimumChoices: Number(event.target.value) })} />
            </Field>
            <Field label="At most">
              <Input type="number" min={1} max={10} value={slot.maximumChoices} onChange={(event) => update(slot.key, { maximumChoices: Number(event.target.value) })} />
            </Field>
            <div className="self-end">
              <Button variant="ghost" aria-label={`Remove course ${index + 1}`} onClick={() => setSlots((current) => current.filter((entry) => entry.key !== slot.key))}>
                <Trash2 aria-hidden className="size-4" />
              </Button>
            </div>
          </div>
          <ul className="grid gap-1">
            {slot.options.map((option) => (
              <li key={option.componentMenuItemId} className="flex flex-wrap items-end gap-2">
                <span className="min-w-40 font-medium">{nameOf.get(option.componentMenuItemId) ?? "Item"}</span>
                <Field label={`Upcharge for ${nameOf.get(option.componentMenuItemId) ?? "item"}`}>
                  <Input
                    inputMode="decimal"
                    value={option.upcharge}
                    onChange={(event) =>
                      update(slot.key, {
                        options: slot.options.map((entry) =>
                          entry.componentMenuItemId === option.componentMenuItemId ? { ...entry, upcharge: event.target.value } : entry,
                        ),
                      })
                    }
                  />
                </Field>
                <Button
                  variant="ghost"
                  aria-label={`Remove ${nameOf.get(option.componentMenuItemId) ?? "choice"}`}
                  onClick={() => update(slot.key, { options: slot.options.filter((entry) => entry.componentMenuItemId !== option.componentMenuItemId) })}
                >
                  <Trash2 aria-hidden className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
          <Field label={`Add a choice to course ${index + 1}`}>
            <Select
              value=""
              onChange={(event) => {
                const value = event.target.value;

                if (value && !slot.options.some((option) => option.componentMenuItemId === value)) {
                  update(slot.key, { options: [...slot.options, { componentMenuItemId: value, upcharge: "0.00" }] });
                }
              }}
            >
              <option value="">Choose an item…</option>
              {components.map((component) => (
                <option key={component.id} value={component.id}>
                  {component.name}
                </option>
              ))}
            </Select>
          </Field>
        </Card>
      ))}
      <FieldHint>Choices are ordinary menu items on an open menu; each keeps its own recipe, stations and modifiers (priced at zero inside the bundle).</FieldHint>
      <ApiErrorMessage error={error} />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setSlots((current) => [...current, blankSlot()])}>
          <Plus aria-hidden className="size-4" /> Add a course
        </Button>
        {slots.length > 0 && (
          <Button variant="primary" pending={pending} pendingLabel="Saving…" onClick={save}>
            Save bundle
          </Button>
        )}
        {config.itemKind === "BUNDLE" && (
          <Button variant="ghost" disabled={pending} onClick={clear}>
            Make an ordinary item
          </Button>
        )}
      </div>
    </div>
  );
}
