import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import { getCurrentAuth } from "@/modules/auth/guards";

export default async function LoginPage() {
  if (await getCurrentAuth()) {
    redirect("/dashboard");
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-neutral-200 p-6 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold">Restaurant Operations</h1>
        <p className="mb-6 text-neutral-600">Sign in to continue.</p>
        <LoginForm />
      </div>
    </main>
  );
}
