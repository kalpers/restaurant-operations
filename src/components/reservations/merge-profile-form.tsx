"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { callOrderApi } from "@/components/orders/order-api";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { INPUT_STYLE } from "@/components/ui/field";

import { GuestPicker, type PickedGuest } from "./guest-picker";

/** Phase 21 (policy 3): merge this duplicate into a profile found by search. Never undone. */
export function MergeProfileForm({ profileId, version }: { profileId: string; version: number }) {
  const router = useRouter();
  const [kept, setKept] = useState<PickedGuest | null>(null);
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string; requestId?: string } | null>(null);

  async function merge() {
    if (!kept) {
      return;
    }

    setPending(true);
    setError(null);

    // The kept profile's current version, so a change made meanwhile is a conflict.
    const current = await callOrderApi<{ version: number }>("GET", `/api/guests/${kept.id}`);
    const result = current.ok
      ? await callOrderApi("POST", `/api/guests/${profileId}/merge`, {
          keptProfileId: kept.id,
          keptVersion: current.data.version,
          duplicateVersion: version,
          reason: reason.trim(),
        })
      : current;

    setPending(false);

    if (result.ok) {
      router.push(`/host/guests/${kept.id}`);
    } else {
      setAsking(false);
      setError({ code: result.code, message: result.message, requestId: result.requestId });
    }
  }

  return (
    <div className="grid gap-3">
      {kept ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          Keep: <span className="font-medium">{kept.displayName}</span>
          <span className="text-neutral-500">#{kept.profileNumber}</span>
          <Button variant="ghost" onClick={() => setKept(null)}>
            Choose another
          </Button>
        </p>
      ) : (
        <GuestPicker canCreate={false} onPick={(picked) => picked.id !== profileId && setKept(picked)} />
      )}
      <label className="grid gap-1 text-sm font-medium">
        Reason
        <input value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} className={INPUT_STYLE} />
      </label>
      <Button onClick={() => setAsking(true)} disabled={!kept || reason.trim() === ""} className="justify-self-start">
        Merge
      </Button>
      {error && <ApiErrorMessage error={error} />}
      <ConfirmDialog
        open={asking}
        title="Merge these profiles?"
        body={`This profile's visits and allergies move to ${kept?.displayName ?? "the profile kept"}, and this one closes. A merge can't be undone.`}
        confirmLabel="Merge profiles"
        pending={pending}
        onConfirm={merge}
        onClose={() => setAsking(false)}
      />
    </div>
  );
}
