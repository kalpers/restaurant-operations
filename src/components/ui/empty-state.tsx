import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "./cn";

type EmptyStateProps = {
  title: string;
  children?: ReactNode;
  icon?: LucideIcon;
  /** Shown only when the caller already knows the user may take it. */
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ title, children, icon: Icon = Inbox, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 rounded-lg border border-dashed border-neutral-300 bg-surface px-4 py-8 text-center",
        className,
      )}
    >
      <Icon aria-hidden className="size-8 text-neutral-500" />
      <p className="font-semibold text-neutral-800">{title}</p>
      {children && <div className="max-w-prose text-sm text-neutral-600">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
