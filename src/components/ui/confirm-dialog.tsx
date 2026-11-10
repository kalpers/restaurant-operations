"use client";

import type { ReactNode } from "react";

import { Button } from "./button";
import { Dialog } from "./dialog";

export type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  /** The label of the button that goes ahead, e.g. "Cancel order". */
  confirmLabel: string;
  /** Label of the button that backs out. */
  cancelLabel?: string;
  tone?: "danger" | "primary";
};

type ConfirmDialogProps = ConfirmOptions & {
  open: boolean;
  pending?: boolean;
  error?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
};

/** Asks before a change that is hard to undo. Focus starts on the safe choice. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Keep it",
  tone = "danger",
  pending = false,
  error,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={pending ? () => {} : onClose}
      title={title}
      description={body}
      footer={
        <>
          <Button data-autofocus onClick={onClose} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant={tone} onClick={onConfirm} pending={pending} pendingLabel="Working…">
            {confirmLabel}
          </Button>
        </>
      }
    >
      {error}
    </Dialog>
  );
}
