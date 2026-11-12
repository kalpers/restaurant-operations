import type { Metadata } from "next";

import { PublicShell } from "@/components/public/public-shell";
import { UnsubscribeButton } from "@/components/public/unsubscribe-button";

export const metadata: Metadata = { title: "Stop booking emails", robots: { index: false, follow: false } };

/** Phase 22 (policy 4): the email opt-out page. Opening it changes nothing; the button does. */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  return (
    <PublicShell title="Stop booking emails">
      <p className="mb-4">Stop emails to this address about bookings at this restaurant? You can still book with us.</p>
      <UnsubscribeButton token={token} />
    </PublicShell>
  );
}
