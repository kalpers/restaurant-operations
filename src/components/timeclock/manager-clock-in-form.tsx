"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { sendApiRequest, type ApiFailure } from "@/components/forms/api-request";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

type StaffMember = { id: string; number: string; name: string; positions: { id: string; name: string }[] };

function newKey(): string {
  return `clockin-${crypto.randomUUID()}`;
}

/**
 * A manager clocks in someone else, such as staff with no login (Phase 18 policy A4). The
 * idempotency key is kept until the punch succeeds, so a retry after a lost response reuses it.
 */
export function ManagerClockInForm({ staff }: { staff: StaffMember[] }) {
  const router = useRouter();
  const toast = useToast();
  const [employeeId, setEmployeeId] = useState("");
  const [positionId, setPositionId] = useState("");
  const [key, setKey] = useState(newKey);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const positions = useMemo(() => staff.find((member) => member.id === employeeId)?.positions ?? [], [staff, employeeId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await sendApiRequest("POST", "/api/timeclock/clock-in", {
      employeeId,
      positionId: positionId || (positions.length === 1 ? positions[0]!.id : null),
      idempotencyKey: key,
    });

    setPending(false);

    if (result.ok) {
      toast.success("Clocked in.");
      setEmployeeId("");
      setPositionId("");
      setKey(newKey());
      router.refresh();
    } else if (result.status === 401) {
      router.push("/login");
    } else {
      setError(result);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" aria-label="Clock someone in">
      <Field label="Employee">
        <Select
          required
          value={employeeId}
          onChange={(event) => {
            setEmployeeId(event.target.value);
            setPositionId("");
          }}
        >
          <option value="">Choose…</option>
          {staff.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name} ({member.number})
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Position">
        <Select value={positionId} onChange={(event) => setPositionId(event.target.value)} disabled={positions.length < 2}>
          <option value="">{positions.length === 1 ? positions[0]!.name : "Choose…"}</option>
          {positions.length > 1 &&
            positions.map((position) => (
              <option key={position.id} value={position.id}>
                {position.name}
              </option>
            ))}
        </Select>
      </Field>
      <Button type="submit" variant="primary" disabled={pending || employeeId === ""}>
        Clock in
      </Button>
      {error && (
        <div className="sm:col-span-3">
          <ApiErrorMessage error={error} />
        </div>
      )}
    </form>
  );
}
