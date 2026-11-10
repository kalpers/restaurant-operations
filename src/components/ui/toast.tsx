"use client";

import { CircleAlert, CircleCheck, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "./cn";

type ToastTone = "success" | "error";
type ToastMessage = { id: number; tone: ToastTone; text: string };
type ToastApi = { success: (text: string) => void; error: (text: string) => void };

const ToastContext = createContext<ToastApi | null>(null);
const DISMISS_AFTER_MS = 4000;

/**
 * Brief, page-level confirmations. The live region always exists so screen readers
 * announce new messages; errors that belong to a form stay inline beside that form.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setMessages((current) => current.filter((message) => message.id !== id));
  }, []);

  const push = useCallback((tone: ToastTone, text: string) => {
    const id = nextId.current++;
    setMessages((current) => [...current.slice(-2), { id, tone, text }]);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({ success: (text) => push("success", text), error: (text) => push("error", text) }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        data-testid="toast-region"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:items-end"
      >
        {messages.map((message) => (
          <ToastItem key={message.id} message={message} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ message, onDismiss }: { message: ToastMessage; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(message.id), DISMISS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [message.id, onDismiss]);

  const Icon = message.tone === "success" ? CircleCheck : CircleAlert;

  return (
    <div
      className={cn(
        "pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-lg border px-4 py-3 text-sm font-medium shadow-lg",
        message.tone === "success"
          ? "border-success-300 bg-success-50 text-success-800"
          : "border-danger-300 bg-danger-50 text-danger-800",
      )}
    >
      <Icon aria-hidden className="size-5 shrink-0" />
      <p className="flex-1">{message.text}</p>
      <button
        type="button"
        onClick={() => onDismiss(message.id)}
        aria-label="Dismiss"
        className="inline-flex size-8 items-center justify-center rounded-md hover:bg-white/60"
      >
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
}

const NO_TOASTS: ToastApi = { success: () => {}, error: () => {} };

/** Outside the app shell (e.g. the login page) toasts are a no-op. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NO_TOASTS;
}
