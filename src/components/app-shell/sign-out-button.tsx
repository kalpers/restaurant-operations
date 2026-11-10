"use client";

import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { signOutToLogin } from "@/modules/auth/client";

export function SignOutButton() {
  return (
    <Button variant="ghost" onClick={() => void signOutToLogin()}>
      <LogOut aria-hidden className="size-4" />
      Log out
    </Button>
  );
}
