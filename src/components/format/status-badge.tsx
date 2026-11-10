import type { ComponentProps } from "react";

import { Badge } from "@/components/ui/badge";

import { statusLabel, statusTone, type StatusDomain } from "./status-labels";

type StatusBadgeProps = Omit<ComponentProps<"span">, "children"> & {
  domain: StatusDomain;
  status: string;
};

/** A human status label. The raw value stays on `data-status` for tests and styling. */
export function StatusBadge({ domain, status, ...props }: StatusBadgeProps) {
  return (
    <Badge tone={statusTone(domain, status)} data-status={status} {...props}>
      {statusLabel(domain, status)}
    </Badge>
  );
}
