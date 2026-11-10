import type { ComponentProps } from "react";

import { cn } from "./cn";

export type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

export const TONE_STYLES: Record<Tone, string> = {
  neutral: "border-neutral-300 bg-neutral-100 text-neutral-800",
  brand: "border-brand-200 bg-brand-50 text-brand-800",
  success: "border-success-300 bg-success-50 text-success-800",
  warning: "border-warning-300 bg-warning-50 text-warning-900",
  danger: "border-danger-300 bg-danger-50 text-danger-800",
  info: "border-info-300 bg-info-50 text-info-800",
};

type BadgeProps = ComponentProps<"span"> & { tone?: Tone };

/** A short label. The text always carries the meaning; the color only reinforces it. */
export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold",
        TONE_STYLES[tone],
        className,
      )}
      {...props}
    />
  );
}
