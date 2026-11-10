import Link from "next/link";
import type { ComponentProps } from "react";

import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brand-700 text-white shadow-sm hover:bg-brand-800",
  secondary:
    "border border-neutral-300 bg-white text-neutral-900 shadow-sm hover:bg-neutral-50",
  danger: "bg-danger-700 text-white shadow-sm hover:bg-danger-800",
  ghost: "text-neutral-800 hover:bg-neutral-100",
};

const SIZES: Record<ButtonSize, string> = {
  md: "min-h-11 px-4 py-2 text-sm",
  lg: "min-h-14 px-6 py-3 text-lg",
};

/** Class names for a button, also used for links that look like buttons. */
export function buttonClass(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

type ButtonProps = ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Disables the button and shows the pending label while a request runs. */
  pending?: boolean;
  pendingLabel?: string;
};

export function Button({
  variant,
  size,
  pending = false,
  pendingLabel,
  className,
  disabled,
  type = "button",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={buttonClass(variant, size, className)}
      {...props}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}

type ButtonLinkProps = ComponentProps<typeof Link> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function ButtonLink({ variant, size, className, ...props }: ButtonLinkProps) {
  return <Link className={buttonClass(variant, size, className)} {...props} />;
}
