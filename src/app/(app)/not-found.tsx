import { SearchX } from "lucide-react";

import { ButtonLink } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="mx-auto grid max-w-lg justify-items-center gap-3 py-12 text-center">
      <SearchX aria-hidden className="size-10 text-neutral-500" />
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="text-neutral-700">
        That record doesn&apos;t exist at this location, or the link is out of date.
      </p>
      <ButtonLink href="/dashboard" variant="primary">
        Go to the dashboard
      </ButtonLink>
    </div>
  );
}
