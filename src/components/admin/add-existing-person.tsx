"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { readFailure, sendApiRequest, type ApiFailure } from "@/components/forms/api-request";
import { apiFetch } from "@/components/forms/page-location";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

// Phase 23 (policy 5, D5): gives someone who already works elsewhere in the organization a
// role at this location. The role picker offers only roles the server would accept.

type Person = { id: string; email: string };

export function AddExistingPerson({ roles }: { roles: { value: string; label: string }[] }) {
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [chosen, setChosen] = useState<string>("");
  const [roleId, setRoleId] = useState(roles[0]?.value ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);

  useEffect(() => {
    const text = query.trim();

    if (text.length < 2) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await apiFetch(`/api/admin/users/candidates?q=${encodeURIComponent(text)}`, {
          signal: controller.signal,
        });

        if (response.ok) {
          setPeople(((await response.json()) as { people: Person[] }).people);
        } else {
          setError(await readFailure(response));
        }
      } catch {
        // Aborted by the next keystroke.
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  async function add() {
    setPending(true);
    setError(null);
    const result = await sendApiRequest("POST", `/api/admin/users/${chosen}/roles`, { roleId });
    setPending(false);

    if (result.ok) {
      toast.success("Added to this location.");
      setChosen("");
      setQuery("");
      setPeople([]);
      router.refresh();
    } else {
      setError(result);
    }
  }

  const shown = query.trim().length < 2 ? [] : people;

  return (
    <div className="grid gap-3">
      <Field label="Find by email">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" />
      </Field>
      {shown.length > 0 && (
        <Field label="Person">
          <Select value={chosen} onChange={(event) => setChosen(event.target.value)}>
            <option value="">Choose…</option>
            {shown.map((person) => (
              <option key={person.id} value={person.id}>
                {person.email}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {query.trim().length >= 2 && shown.length === 0 && (
        <p className="text-sm text-neutral-600">Nobody else in the organization matches.</p>
      )}
      <Field label="Role at this location">
        <Select value={roleId} onChange={(event) => setRoleId(event.target.value)}>
          {roles.map((role) => (
            <option key={role.value} value={role.value}>
              {role.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={!chosen || !roleId} pending={pending} onClick={() => void add()}>
          Add to this location
        </Button>
        <ApiErrorMessage error={error} />
      </div>
    </div>
  );
}
