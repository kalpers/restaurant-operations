"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { sendApiRequest, type ApiFailure } from "@/components/forms/api-request";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { CHECKLIST_KINDS } from "@/db/schema/checklists";
import type { ChecklistTemplateView } from "@/modules/restaurant/services/checklist-service";

import { CHECKLIST_KIND_LABELS } from "./checklist-status-badge";

type Failure = Pick<ApiFailure, "code" | "message" | "requestId">;
type Position = { id: string; name: string };
type ItemDraft = { key: string; id: string | null; text: string; required: boolean };

/** Phase 36 (policy 5): managers set up the location's checklist templates. */
export function ChecklistTemplateManager({ templates, positions }: { templates: ChecklistTemplateView[]; positions: Position[] }) {
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="grid gap-6">
      <Card>
        <h2 className="mb-3 text-lg font-semibold">New checklist</h2>
        <TemplateForm positions={positions} onDone={() => undefined} />
      </Card>
      {templates.length === 0 ? (
        <EmptyState title="No checklists yet">Add an opening, closing or side-work checklist above.</EmptyState>
      ) : (
        <ul className="grid gap-3">
          {templates.map((template) => (
            <li key={template.id}>
              <Card className="grid gap-2" data-testid="checklist-template">
                {editing === template.id ? (
                  <TemplateForm template={template} positions={positions} onDone={() => setEditing(null)} />
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold">{template.name}</h3>
                      <Badge>{CHECKLIST_KIND_LABELS[template.kind]}</Badge>
                      {template.requiresSignOff && <Badge tone="warning">Needs sign-off</Badge>}
                      {!template.active && <Badge tone="danger">Inactive</Badge>}
                      {template.positions.length === 0 ? (
                        <Badge>Everyone</Badge>
                      ) : (
                        template.positions.map((position) => (
                          <Badge key={position.id} tone="info">
                            {position.name}
                          </Badge>
                        ))
                      )}
                    </div>
                    <ol className="list-decimal pl-6 text-sm">
                      {template.items
                        .filter((item) => item.active)
                        .map((item) => (
                          <li key={item.id}>
                            {item.text}
                            {!item.required && <span className="text-neutral-600"> (optional)</span>}
                          </li>
                        ))}
                    </ol>
                    <div>
                      <Button variant="secondary" onClick={() => setEditing(template.id)}>
                        Edit
                      </Button>
                    </div>
                  </>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

let nextKey = 0;
const newKey = () => `item-${(nextKey += 1)}`;

function TemplateForm({ template, positions, onDone }: { template?: ChecklistTemplateView; positions: Position[]; onDone: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [items, setItems] = useState<ItemDraft[]>(
    template
      ? template.items.filter((item) => item.active).map((item) => ({ key: item.id, id: item.id, text: item.text, required: item.required }))
      : [{ key: newKey(), id: null, text: "", required: true }],
  );
  const choices = [...positions, ...(template?.positions.filter((kept) => !positions.some((p) => p.id === kept.id)) ?? [])];

  const move = (index: number, by: number) =>
    setItems((current) => {
      const next = [...current];
      const [moved] = next.splice(index, 1);

      next.splice(index + by, 0, moved!);

      return next;
    });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = event.currentTarget;
    const data = new FormData(form);
    const body = {
      name: data.get("name"),
      kind: data.get("kind"),
      requiresSignOff: data.get("requiresSignOff") === "on",
      positionIds: data.getAll("positionIds"),
      items: items.filter((item) => item.text.trim()).map((item) => ({ id: item.id, text: item.text, required: item.required })),
      ...(template ? { active: data.get("active") === "on", expectedVersion: template.version } : {}),
    };

    setPending(true);
    setError(null);

    const result = template
      ? await sendApiRequest("PATCH", `/api/checklists/templates/${template.id}`, body)
      : await sendApiRequest("POST", "/api/checklists/templates", body);

    setPending(false);

    if (result.ok) {
      if (!template) {
        form.reset();
        setItems([{ key: newKey(), id: null, text: "", required: true }]);
      }

      toast.success(template ? "Checklist saved." : "Checklist added.");
      onDone();
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-3" aria-label={template ? `Edit ${template.name}` : "New checklist"}>
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <Field label="Name">
          <Input name="name" required maxLength={80} defaultValue={template?.name ?? ""} />
        </Field>
        <Field label="Kind">
          <Select name="kind" defaultValue={template?.kind ?? "OPENING"}>
            {CHECKLIST_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {CHECKLIST_KIND_LABELS[kind]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium text-neutral-800">Items, in order</legend>
        {items.map((item, index) => (
          <div key={item.key} className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={`Item ${index + 1}`}
              className="min-w-48 flex-1"
              maxLength={200}
              value={item.text}
              onChange={(event) =>
                setItems((current) => current.map((entry) => (entry.key === item.key ? { ...entry, text: event.target.value } : entry)))
              }
            />
            <Checkbox
              label="Required"
              checked={item.required}
              onChange={(event) =>
                setItems((current) => current.map((entry) => (entry.key === item.key ? { ...entry, required: event.target.checked } : entry)))
              }
            />
            <Button variant="ghost" aria-label={`Move item ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}>
              <ArrowUp aria-hidden className="size-4" />
            </Button>
            <Button
              variant="ghost"
              aria-label={`Move item ${index + 1} down`}
              disabled={index === items.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDown aria-hidden className="size-4" />
            </Button>
            <Button
              variant="ghost"
              aria-label={`Remove item ${index + 1}`}
              disabled={items.length === 1}
              onClick={() => setItems((current) => current.filter((entry) => entry.key !== item.key))}
            >
              <Trash2 aria-hidden className="size-4" />
            </Button>
          </div>
        ))}
        <div>
          <Button variant="secondary" onClick={() => setItems((current) => [...current, { key: newKey(), id: null, text: "", required: true }])}>
            <Plus aria-hidden className="size-4" /> Add item
          </Button>
        </div>
      </fieldset>
      <fieldset className="grid gap-1">
        <legend className="text-sm font-medium text-neutral-800">For (none chosen means everyone)</legend>
        <div className="flex flex-wrap gap-x-4">
          {choices.map((position) => (
            <Checkbox
              key={position.id}
              name="positionIds"
              value={position.id}
              label={position.name}
              defaultChecked={template?.positions.some((chosen) => chosen.id === position.id) ?? false}
            />
          ))}
        </div>
      </fieldset>
      <Checkbox name="requiresSignOff" label="A manager signs it off after it's completed" defaultChecked={template?.requiresSignOff ?? false} />
      {template && <Checkbox name="active" label="In use" defaultChecked={template.active} />}
      <ApiErrorMessage error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" pending={pending} pendingLabel="Saving…">
          {template ? "Save checklist" : "Add checklist"}
        </Button>
        {template && (
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
