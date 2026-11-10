"use client";

import { CircleAlert, Eye, EyeOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { INPUT_STYLE } from "@/components/ui/field";
import { signInWithPassword } from "@/modules/auth/client";

export function LoginForm() {
  const router = useRouter();
  const passwordId = useId();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);

    setPending(true);
    setFailed(false);

    const signedIn = await signInWithPassword({
      email: String(data.get("email")),
      password: String(data.get("password")),
    }).catch(() => false);

    if (signedIn) {
      router.replace("/dashboard");
      router.refresh();
    } else {
      setPending(false);
      setFailed(true);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4">
      <label className="grid gap-1 text-sm font-medium">
        Email
        <input type="email" name="email" required autoComplete="username" className={INPUT_STYLE} />
      </label>
      <div className="grid gap-1">
        <label htmlFor={passwordId} className="text-sm font-medium">
          Password
        </label>
        <div className="flex gap-2">
          <input
            id={passwordId}
            type={showPassword ? "text" : "password"}
            name="password"
            required
            autoComplete="current-password"
            className={INPUT_STYLE}
          />
          {/* Named "Show"/"Hide" so it never matches the field's own "Password" label. */}
          <button
            type="button"
            aria-pressed={showPassword}
            aria-controls={passwordId}
            title={showPassword ? "Hide the password" : "Show the password"}
            onClick={() => setShowPassword((value) => !value)}
            className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md border border-neutral-300 bg-white px-3 text-sm font-medium shadow-sm hover:bg-neutral-50"
          >
            {showPassword ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
            {showPassword ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      {/* The same message for every failure, whatever the reason. */}
      {failed && (
        <p role="alert" className="flex items-center gap-2 rounded-md border border-danger-300 bg-danger-50 p-3 text-danger-800">
          <CircleAlert aria-hidden className="size-5 shrink-0" />
          Invalid email or password
        </p>
      )}
      <Button type="submit" variant="primary" size="lg" pending={pending} pendingLabel="Signing in...">
        Sign in
      </Button>
    </form>
  );
}
