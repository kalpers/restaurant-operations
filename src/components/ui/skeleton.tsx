import { cn } from "./cn";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-neutral-200", className)} />;
}

/**
 * Stands in for data sections while a slow page section loads inside `Suspense`
 * (Phase 20 policy 21). Route-level `loading.tsx` stays out (Phase 15 decision).
 */
export function SectionsSkeleton({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="grid gap-4">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-40" />
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-32" />
    </div>
  );
}

/** A generic page placeholder: a heading and a few blocks of content. */
export function PageSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="grid gap-4">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="h-48" />
    </div>
  );
}
