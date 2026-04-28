/**
 * Per-device playback-speed memory for the video feed. The user picks
 * a rate once (via the corner pill on the video) and we remember it
 * across PRs and reloads — flipping back to 1× on every navigation
 * was annoying for anyone who wanted to skim at 2× or read carefully
 * at 0.5×.
 *
 * Stored in localStorage under a versioned key. Hydrated after mount
 * so SSR markup matches client first-paint at the default rate, then
 * the persisted rate fills in on the next tick (same pattern as
 * seen-videos.ts).
 */

"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "tiktest:playback-rate:v1";

/** Allowed rates, in cycle order. Tap-to-cycle steps through these in
 *  sequence and wraps. Order is "1× → speed up → max → slow down →
 *  back to 1×": most users want to skim faster, so we surface 1.5×
 *  and 2× before the slow option. */
export const PLAYBACK_RATES = [1, 1.5, 2, 0.5] as const;

export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

function isValidRate(n: unknown): n is PlaybackRate {
  return typeof n === "number" && (PLAYBACK_RATES as readonly number[]).includes(n);
}

/** Read the persisted rate. Falls back to 1× on SSR / parse failure /
 *  unknown rate (in case the cycle constants change between releases). */
export function getStoredRate(): PlaybackRate {
  if (typeof window === "undefined") return 1;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return 1;
    const parsed = JSON.parse(raw);
    return isValidRate(parsed) ? parsed : 1;
  } catch {
    return 1;
  }
}

function persistRate(rate: PlaybackRate): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rate));
  } catch {
    // Storage disabled / quota exceeded — silent fail. Rate just won't
    // persist past the current session; harmless for an enhancement.
  }
}

/**
 * Hook: exposes the current rate + a stable `cycleRate` callback that
 * advances to the next preset and persists it. Returns 1× during SSR
 * and pre-hydration.
 */
export function usePlaybackRate(): {
  rate: PlaybackRate;
  cycleRate: () => void;
} {
  const [rate, setRate] = useState<PlaybackRate>(1);

  useEffect(() => {
    setRate(getStoredRate());
  }, []);

  const cycleRate = useCallback(() => {
    setRate((prev) => {
      const i = PLAYBACK_RATES.indexOf(prev);
      const next = PLAYBACK_RATES[(i + 1) % PLAYBACK_RATES.length];
      persistRate(next);
      return next;
    });
  }, []);

  return { rate, cycleRate };
}

/** Format a rate for the corner pill: `1×`, `1.5×`, `2×`, `0.5×`. */
export function formatRate(rate: PlaybackRate): string {
  return `${rate}×`;
}
