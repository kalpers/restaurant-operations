"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { sendApiRequest, type ApiFailure } from "@/components/forms/api-request";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

type Position = { id: string; code: string; name: string };
type Rule = { active: boolean; name: string | null; version: number | null; positions: { positionId: string; points: string }[] };

/** The Location's pool: which positions share tips, and their points (Phase 18 policy D23). */
export function TipRuleForm({ rule, positions }: { rule: Rule; positions: Position[] }) {
  const router = useRouter();
  const toast = useToast();
  const [active, setActive] = useState(rule.active);
  const [points, setPoints] = useState<Record<string, string>>(
    Object.fromEntries(rule.positions.map((position) => [position.positionId, position.points])),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await sendApiRequest("PUT", "/api/tips/rule", {
      name: rule.name,
      active,
      positions: Object.entries(points)
        .filter(([, value]) => value.trim() !== "")
        .map(([positionId, value]) => ({ positionId, points: value.trim() })),
      expectedVersion: rule.version,
    });

    setPending(false);

    if (result.ok) {
      toast.success("Tip pool saved.");
      router.refresh();
    } else if (result.status === 401) {
      router.push("/login");
    } else {
      setError(result);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4" aria-label="Tip pool">
      <Checkbox label="Pool tips at this location" checked={active} onChange={(event) => setActive(event.target.checked)} />
      <p className="text-sm text-neutral-700">
        Give each sharing position its points. A share is hours worked × points. Leave a position blank to leave it out.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {positions.map((position) => (
          <Field key={position.id} label={`${position.name} points`}>
            <Input
              inputMode="decimal"
              value={points[position.id] ?? ""}
              onChange={(event) => setPoints((current) => ({ ...current, [position.id]: event.target.value }))}
            />
          </Field>
        ))}
      </div>
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          Save tip pool
        </Button>
      </div>
      {error && <ApiErrorMessage error={error} />}
    </form>
  );
}
