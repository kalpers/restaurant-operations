"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { readFailure, sendApiJson, type ApiFailure } from "@/components/forms/api-request";
import { apiFetch } from "@/components/forms/page-location";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import type { SupplierInvoiceStatus } from "@/db/schema/supplier-invoices";

type Failure = Pick<ApiFailure, "code" | "message" | "requestId">;
type Pending = { action: "approve" | "dispute" | "void"; title: string; label: string; required: boolean } | null;

/** Phase 36 (policy 8): approve, dispute and void an invoice, and attach its scanned copy. */
export function InvoiceActions({
  invoiceId,
  status,
  version,
  linesNeedingReason,
  canRecord,
  canApprove,
}: {
  invoiceId: string;
  status: SupplierInvoiceStatus;
  version: number;
  linesNeedingReason: number;
  canRecord: boolean;
  canApprove: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [dialog, setDialog] = useState<Pending>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const editable = status === "DRAFT" || status === "DISPUTED";

  async function submit() {
    if (!dialog) {
      return;
    }

    setBusy(true);
    setError(null);

    const result = await sendApiJson("POST", `/api/purchasing/invoices/${invoiceId}/${dialog.action}`, {
      reason: reason.trim() || null,
      expectedVersion: version,
    });

    setBusy(false);

    if (result.ok) {
      toast.success(dialog.action === "approve" ? "Invoice approved." : dialog.action === "dispute" ? "Invoice disputed." : "Invoice voided.");
      setDialog(null);
      setReason("");
      router.refresh();
    } else {
      setError(result);
    }
  }

  async function upload(file: File) {
    const form = new FormData();

    form.set("file", file);
    form.set("expectedVersion", String(version));
    setBusy(true);
    setError(null);

    const response = await apiFetch(`/api/purchasing/invoices/${invoiceId}/file`, { method: "POST", body: form }).catch(() => null);

    setBusy(false);

    if (response?.ok) {
      toast.success("Scanned copy attached.");
      router.refresh();
    } else {
      setError(response ? await readFailure(response) : { code: "NETWORK", message: "Couldn't reach the server." });
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {canApprove && editable && (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              setDialog({
                action: "approve",
                title: "Approve this invoice?",
                label: linesNeedingReason > 0 ? "Why approve despite the variances?" : "Note (optional)",
                required: linesNeedingReason > 0,
              })
            }
          >
            Approve
          </Button>
        )}
        {canApprove && status === "DRAFT" && (
          <Button variant="secondary" disabled={busy} onClick={() => setDialog({ action: "dispute", title: "Dispute this invoice?", label: "What is disputed?", required: true })}>
            Dispute
          </Button>
        )}
        {canApprove && status !== "VOIDED" && (
          <Button variant="ghost" disabled={busy} onClick={() => setDialog({ action: "void", title: "Void this invoice?", label: "Why is it voided?", required: true })}>
            Void
          </Button>
        )}
        {canRecord && editable && (
          <label className="inline-flex min-h-11 cursor-pointer items-center rounded-md border border-neutral-300 px-4 text-sm font-medium">
            Attach scanned copy
            <input
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];

                if (file) {
                  void upload(file);
                }
              }}
            />
          </label>
        )}
      </div>
      <ApiErrorMessage error={error} />
      <Dialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog?.title ?? ""}
        description={
          dialog?.action === "approve"
            ? "Approving stores each line's variances as they are now. Inventory cost isn't changed."
            : dialog?.action === "void"
              ? "A voided invoice can't be changed; its received lines can go on another invoice."
              : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant={dialog?.action === "void" ? "danger" : "primary"}
              pending={busy}
              disabled={dialog?.required === true && !reason.trim()}
              onClick={submit}
            >
              {dialog?.action === "approve" ? "Approve invoice" : dialog?.action === "dispute" ? "Dispute invoice" : "Void invoice"}
            </Button>
          </>
        }
      >
        <Field label={dialog?.label ?? "Reason"}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={3} />
        </Field>
      </Dialog>
    </div>
  );
}
