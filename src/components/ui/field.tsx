import type { ComponentProps, ReactNode } from "react";

import { cn } from "./cn";

/** The shared look of every text input, select and textarea, at its natural width. */
export const INPUT_BASE =
  "min-h-11 rounded-md border border-neutral-300 bg-white px-3 py-2 text-base shadow-sm placeholder:text-neutral-500 disabled:bg-neutral-100 aria-invalid:border-danger-600";

/** The same, filling its container: the usual choice inside a form. */
export const INPUT_STYLE = `${INPUT_BASE} w-full`;

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(INPUT_STYLE, className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(INPUT_STYLE, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(INPUT_STYLE, className)} {...props} />;
}

type FieldProps = {
  label: ReactNode;
  children: ReactNode;
  className?: string;
};

/**
 * A label wrapping its control, so the label is the control's accessible name.
 * Hints belong outside the label (use `FieldHint`) so they don't change that name.
 */
export function Field({ label, children, className }: FieldProps) {
  return (
    <label className={cn("grid gap-1 text-sm font-medium text-neutral-800", className)}>
      {label}
      {children}
    </label>
  );
}

export function FieldHint({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p id={id} className="text-xs text-neutral-600">
      {children}
    </p>
  );
}

export function Checkbox({ label, className, ...props }: ComponentProps<"input"> & { label: ReactNode }) {
  return (
    <label className={cn("flex min-h-11 items-center gap-3 text-sm", className)}>
      <input type="checkbox" className="size-5 accent-brand-700" {...props} />
      {label}
    </label>
  );
}
