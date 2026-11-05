"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { signInWithPassword } from "@/modules/auth/client";

const INPUT_CLASS =
  "min-h-11 w-full rounded border border-neutral-300 bg-white px-3 py-2 text-base";

export function LoginForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

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
        <input
          type="email"
          name="email"
          required
          autoComplete="username"
          className={INPUT_CLASS}
        />
      </label>
      <label className="grid gap-1 text-sm font-medium">
        Password
        <input
          type="password"
          name="password"
          required
          autoComplete="current-password"
          className={INPUT_CLASS}
        />
      </label>
      {failed && (
        <p role="alert" className="text-red-700">
          Invalid email or password
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 rounded bg-neutral-900 px-4 py-2 font-medium text-white disabled:opacity-50"
      >
        {pending ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}
