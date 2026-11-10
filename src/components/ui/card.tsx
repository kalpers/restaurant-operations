import type { ComponentProps, ReactNode } from "react";

import { cn } from "./cn";

export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn("rounded-lg border border-neutral-200 bg-surface p-4 shadow-sm", className)}
      {...props}
    />
  );
}

export function CardTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn("mb-3 text-lg font-semibold", className)}>{children}</h2>;
}
