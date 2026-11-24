"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { sendApiJson, type ApiFailure } from "@/components/forms/api-request";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, FieldHint, Input, Select, Textarea } from "@/components/ui/field";
import { Table, TableFrame, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { isInRange } from "@/modules/restaurant/rules/temperature-rules";
import type { TemperatureReadingView } from "@/modules/restaurant/services/temperature-service";
import { randomUuid } from "@/shared/random-uuid";

import type { ClientCheck } from "./temperature-checks";

type Failure = Pick<ApiFailure, "code" | "message" | "requestId">;
type Link = { kind: "recheck" | "correct"; reading: TemperatureReadingView } | null;

const newKey = () => `temp-${randomUuid()}`;
const timeOf = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone });

/**
 * Phase 36 (policy 6): what's due, a form to record a reading, and the log. An out-of-range
 * reading needs a corrective action; a mistake is fixed with a correcting reading, never an edit.
 */
export function TemperatureLogWorkspace({
  checks,
  readings,
  canRecord,
  timeZone,
}: {
  checks: ClientCheck[];
  readings: TemperatureReadingView[];
  canRecord: boolean;
  timeZone: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pointId, setPointId] = useState(checks[0]?.point.id ?? "");
  const [value, setValue] = useState("");
  const [action, setAction] = useState("");
  const [link, setLink] = useState<Link>(null);
  const [key, setKey] = useState(newKey);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const point = checks.find((check) => check.point.id === pointId)?.point ?? null;
  const outOfRange = useMemo(() => {
    if (!point || !/^-?\d{1,3}(\.\d)?$/.test(value.trim())) {
      return false;
    }

    return !isInRange(value.trim(), point.minimumValue, point.maximumValue);
  }, [point, value]);

  function chooseLink(next: Link) {
    setLink(next);

    if (next) {
      setPointId(next.reading.pointId);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await sendApiJson<{ inRange: boolean }>("POST", "/api/temperature-log/readings", {
      idempotencyKey: key,
      pointId,
      value,
      correctiveAction: action.trim() ? action : null,
      followsUpReadingId: link?.kind === "recheck" ? link.reading.id : null,
      correctsReadingId: link?.kind === "correct" ? link.reading.id : null,
    });

    setPending(false);

    if (result.ok) {
      toast.success(result.data.inRange ? "Reading recorded." : "Out-of-range reading recorded. Managers have been told.");
      setKey(newKey());
      setValue("");
      setAction("");
      setLink(null);
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <div className="grid gap-6">
      {checks.length === 0 ? (
        <EmptyState title="No check points">A manager sets up the coolers, freezers and hot wells to check.</EmptyState>
      ) : (
        <section aria-labelledby="checks-heading" className="grid gap-3">
          <h2 id="checks-heading" className="text-lg font-semibold">
            Check points
          </h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {checks.map((check) => (
              <li key={check.point.id}>
                <Card className="grid gap-1" data-testid="temperature-check">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{check.point.name}</h3>
                    {check.status.state === "OVERDUE" && <Badge tone="danger">Check overdue</Badge>}
                    {check.status.state === "OK" && check.status.dueAt && <Badge tone="success">Next by {timeOf(check.status.dueAt, timeZone)}</Badge>}
                  </div>
                  <p className="text-sm text-neutral-700">Safe range {check.point.rangeText}</p>
                  <p className="text-sm text-neutral-700">
                    {check.lastReading
                      ? `Last: ${check.lastReading.value} °${check.point.unit} at ${timeOf(check.lastReading.takenAt, timeZone)}${check.lastReading.inRange ? "" : " (out of range)"}`
                      : "No reading yet."}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}

      {canRecord && checks.length > 0 && (
        <Card>
          <form onSubmit={handleSubmit} className="grid gap-3" aria-label="Record a reading">
            <h2 className="text-lg font-semibold">Record a reading</h2>
            {link && (
              <p className="flex flex-wrap items-center gap-2 text-sm">
                {link.kind === "recheck" ? "Recheck of" : "Corrects"} the {link.reading.value} °{link.reading.unit} reading at{" "}
                {timeOf(link.reading.takenAt, timeZone)}.
                <Button variant="ghost" onClick={() => setLink(null)}>
                  Cancel
                </Button>
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
              <Field label="Check point">
                <Select value={pointId} onChange={(event) => setPointId(event.target.value)} disabled={link !== null}>
                  {checks.map((check) => (
                    <option key={check.point.id} value={check.point.id}>
                      {check.point.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={`Temperature (°${point?.unit ?? "F"})`}>
                <Input inputMode="decimal" required value={value} onChange={(event) => setValue(event.target.value)} />
              </Field>
            </div>
            {point && <FieldHint>Safe range {point.rangeText}</FieldHint>}
            {outOfRange && (
              <p role="alert" className="rounded border border-danger-300 bg-danger-50 p-2 text-sm text-danger-800">
                Out of range. Say what was done about it.
              </p>
            )}
            <Field label={outOfRange ? "Corrective action (required)" : "Corrective action (optional)"}>
              <Textarea value={action} onChange={(event) => setAction(event.target.value)} maxLength={500} rows={2} required={outOfRange} />
            </Field>
            <ApiErrorMessage error={error} />
            <div>
              <Button type="submit" variant="primary" pending={pending} pendingLabel="Recording…">
                Record reading
              </Button>
            </div>
          </form>
        </Card>
      )}

      <section aria-labelledby="log-heading" className="grid gap-3">
        <h2 id="log-heading" className="text-lg font-semibold">
          Log
        </h2>
        {readings.length === 0 ? (
          <EmptyState title="No readings">No readings for these dates.</EmptyState>
        ) : (
          <TableFrame>
            <Table>
              <THead>
                <Tr>
                  <Th>Date</Th>
                  <Th>Time</Th>
                  <Th>Check point</Th>
                  <Th numeric>Temperature</Th>
                  <Th>Range</Th>
                  <Th>Corrective action</Th>
                  <Th>By</Th>
                  {canRecord && <Th>Actions</Th>}
                </Tr>
              </THead>
              <TBody>
                {readings.map((reading) => (
                  <Tr key={reading.id} data-testid="temperature-reading">
                    <Td>{reading.businessDate}</Td>
                    <Td>{timeOf(reading.takenAt, timeZone)}</Td>
                    <Td>{reading.pointName}</Td>
                    <Td numeric>
                      <span className={reading.correctedByReadingId ? "line-through" : undefined}>
                        {reading.value} °{reading.unit}
                      </span>
                    </Td>
                    <Td>
                      <span className="grid gap-1">
                        {reading.rangeText}
                        {!reading.inRange && <Badge tone="danger">Out of range</Badge>}
                        {reading.correctedByReadingId && <Badge>Corrected</Badge>}
                        {reading.correctsReadingId && <Badge tone="info">Correction</Badge>}
                        {reading.followsUpReadingId && <Badge tone="info">Recheck</Badge>}
                      </span>
                    </Td>
                    <Td>{reading.correctiveAction}</Td>
                    <Td>{reading.recordedByName ?? "No employee record"}</Td>
                    {canRecord && (
                      <Td>
                        <span className="flex flex-wrap gap-1">
                          {!reading.inRange && (
                            <Button variant="ghost" onClick={() => chooseLink({ kind: "recheck", reading })}>
                              Recheck
                            </Button>
                          )}
                          {!reading.correctedByReadingId && (
                            <Button variant="ghost" onClick={() => chooseLink({ kind: "correct", reading })}>
                              Correct
                            </Button>
                          )}
                        </span>
                      </Td>
                    )}
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </section>
    </div>
  );
}
