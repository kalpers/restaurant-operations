"use client";

import { Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { AgeBand } from "@/modules/kitchen/rules/fulfillment-rules";

// Display of the server's age band (Phase 10 rule: warning at 10 minutes, late at 20).
// The band is computed on the server; nothing here decides it.

export const AGE_BORDER: Record<AgeBand, string> = {
  normal: "border-neutral-300",
  warning: "border-warning-500 border-4",
  late: "border-danger-600 border-[6px]",
};

export const AGE_HEADER: Record<AgeBand, string> = {
  normal: "bg-neutral-100 text-neutral-900",
  warning: "bg-warning-100 text-warning-900",
  late: "bg-danger-700 text-white",
};

/** Text for the band, so lateness is never shown by color alone. */
export const AGE_LABEL: Record<AgeBand, string | null> = {
  normal: null,
  warning: "10+ min",
  late: "Late · 20+ min",
};

export function elapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);

  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Seconds since submission: the server's age at render plus a local tick. Cards remount on
 * every refresh (keyed by server time), so the count never drifts far from the server.
 */
export function useAge(serverAgeSeconds: number) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);

    return () => clearInterval(timer);
  }, []);

  return serverAgeSeconds + tick;
}

const SOUND_KEY = "kds.new-ticket-sound";

function readSoundPreference(): boolean {
  try {
    return window.localStorage.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
}

function beep() {
  try {
    const AudioContextClass = window.AudioContext;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.4);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.4);
    oscillator.onended = () => void context.close();
  } catch {
    // No audio available; the card itself still appears.
  }
}

/**
 * An optional chime when a ticket the screen hasn't seen arrives. Off by default; the choice
 * is a per-browser convenience kept in localStorage, never shared or sent anywhere.
 */
export function useNewTicketSound(ticketIds: readonly string[]) {
  const [enabled, setEnabled] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  const key = ticketIds.join(",");

  useEffect(() => {
    // Read after mount: the server render can't see this browser's storage.
    const stored = readSoundPreference();
    const timer = setTimeout(() => setEnabled(stored), 0);

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const ids = key ? key.split(",") : [];

    if (seen.current === null) {
      seen.current = new Set(ids);

      return;
    }

    const fresh = ids.some((id) => !seen.current?.has(id));

    seen.current = new Set(ids);

    if (fresh && enabled) {
      beep();
    }
  }, [key, enabled]);

  function toggle() {
    const next = !enabled;

    setEnabled(next);

    try {
      window.localStorage.setItem(SOUND_KEY, next ? "on" : "off");
    } catch {
      // Storage blocked: the setting lasts for this page only.
    }
  }

  return { enabled, toggle };
}

export function SoundToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  const Icon = enabled ? Volume2 : VolumeX;

  return (
    <button
      type="button"
      aria-pressed={enabled}
      onClick={onToggle}
      className="inline-flex min-h-11 items-center gap-2 rounded-md border border-neutral-300 bg-white px-3 text-sm font-medium shadow-sm hover:bg-neutral-50"
    >
      <Icon aria-hidden className="size-4" />
      New-ticket sound
    </button>
  );
}
