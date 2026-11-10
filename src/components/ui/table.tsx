import type { ComponentProps } from "react";

import { cn } from "./cn";

/** Scrolls wide tables inside their frame, so the page itself never scrolls sideways. */
export function TableFrame({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("overflow-x-auto rounded-lg border border-neutral-200 bg-surface shadow-sm", className)}
      {...props}
    />
  );
}

export function Table({ className, ...props }: ComponentProps<"table">) {
  return <table className={cn("w-full border-collapse text-left text-sm", className)} {...props} />;
}

export function THead({ className, ...props }: ComponentProps<"thead">) {
  return (
    <thead
      className={cn("sticky top-0 bg-neutral-100 text-neutral-800", className)}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={cn("[&>tr:nth-child(even)]:bg-neutral-50", className)} {...props} />;
}

export function Tr({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("border-b border-neutral-200 last:border-0", className)} {...props} />;
}

type CellProps = { numeric?: boolean };

export function Th({ numeric, className, ...props }: ComponentProps<"th"> & CellProps) {
  return (
    <th
      scope="col"
      className={cn("px-3 py-2 font-semibold", numeric && "text-right", className)}
      {...props}
    />
  );
}

export function Td({ numeric, className, ...props }: ComponentProps<"td"> & CellProps) {
  return (
    <td className={cn("px-3 py-2 align-top", numeric && "tabular text-right", className)} {...props} />
  );
}
