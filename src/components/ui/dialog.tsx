"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

import { cn } from "./cn";

type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
};

/**
 * A modal built on the native <dialog>. `showModal()` makes the rest of the page inert,
 * Escape closes it, and focus returns to the control that opened it.
 *
 * The element exists only while open. That keeps it out of the server HTML, where a
 * <dialog> inside a <p> or <span> would be re-parented by the HTML parser and break
 * hydration, and it keeps the dialog in place in the DOM next to its opener.
 */
export function Dialog(props: DialogProps) {
  return props.open ? <OpenDialog {...props} /> : null;
}

function OpenDialog({ onClose, title, description, children, footer, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (dialog && !dialog.open) {
      dialog.showModal();
      // React's autoFocus runs before the dialog opens, so the starting control is marked
      // with data-autofocus and focused here instead.
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }

    return () => {
      // Unmounting closes it; send focus back to whatever opened it.
      if (opener?.isConnected) {
        opener.focus();
      }
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className={cn(
        "m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-neutral-200 bg-surface p-0 text-neutral-900 shadow-xl",
        className,
      )}
    >
      <div className="grid gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-1">
            <h2 id={titleId} className="text-lg font-semibold">
              {title}
            </h2>
            {description && (
              <div id={descriptionId} className="text-sm text-neutral-700">
                {description}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-2 inline-flex size-11 items-center justify-center rounded-md text-neutral-600 hover:bg-neutral-100"
          >
            <X aria-hidden className="size-5" />
          </button>
        </div>
        {children}
        {footer && <div className="flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </dialog>
  );
}
