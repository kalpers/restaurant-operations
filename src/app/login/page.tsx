import { UtensilsCrossed } from "lucide-react";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import { getCurrentAuth } from "@/modules/auth/guards";

export default async function LoginPage() {
  if (await getCurrentAuth()) {
    redirect("/dashboard");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 via-canvas to-neutral-100 p-4">
      <div className="w-full max-w-sm rounded-xl border border-neutral-200 bg-surface p-6 shadow-lg">
        <div className="mb-6 flex items-center gap-3">
          <span className="inline-flex size-11 items-center justify-center rounded-lg bg-brand-700 text-white">
            <UtensilsCrossed aria-hidden className="size-6" />
          </span>
          <div>
            <h1 className="text-xl font-semibold">Restaurant Operations</h1>
            <p className="text-sm text-neutral-700">Sign in to continue.</p>
          </div>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
