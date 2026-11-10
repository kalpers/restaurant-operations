import { SearchX } from "lucide-react";

import { ButtonLink } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="mx-auto grid min-h-screen max-w-lg content-center justify-items-center gap-3 px-4 text-center">
      <SearchX aria-hidden className="size-10 text-neutral-500" />
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-neutral-700">There&apos;s no page at this address.</p>
      <ButtonLink href="/dashboard" variant="primary">
        Go to the dashboard
      </ButtonLink>
    </main>
  );
}
