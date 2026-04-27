/**
 * Per-device "have I watched this video" memory.
 *
 * Stored in localStorage as a JSON-encoded string array under a versioned
 * key — bump the version (and provide a migration) if the shape ever
 * changes. The key is intentionally global (not per-repo); a tik-test
 * runId is unique across the planet so there's no risk of collision and
 * a user who reviewed the same PR via two different repo views shouldn't
 * see the badge flip back to NEW.
 *
 * Hydration: localStorage isn't available during SSR, so the hook starts
 * empty and populates from a useEffect on mount. That avoids a server/
 * client text mismatch on the badge.
 */

"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "tiktest:seen-videos:v1";

/** Read the persisted set. Returns an empty Set on SSR or on parse error. */
export function getSeenIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x) => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

/** Persist a single id. No-op on SSR or if the id is empty. */
function persistSeenIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Quota exceeded or storage disabled — silent fail. Badges will reset
    // on next visit; that's acceptable for an enhancement, not core flow.
  }
}

/**
 * Hook: exposes the current seen-id set + a stable `markSeen(id)` callback.
 *
 *  - `seenIds` re-renders when an id is added.
 *  - `markSeen` is idempotent (re-marking is a no-op).
 *  - Empty / falsy ids are silently ignored — defends the badge against
 *    a malformed marker that left runId blank.
 */
export function useSeenVideos(): {
  seenIds: Set<string>;
  markSeen: (id: string) => void;
  isSeen: (id: string) => boolean;
} {
  const [seenIds, setSeenIds] = useState<Set<string>>(() => new Set());

  // Hydrate from localStorage AFTER mount so SSR markup matches the first
  // client paint (everything starts NEW, then any persisted ids fill in
  // on the next tick).
  useEffect(() => {
    setSeenIds(getSeenIds());
  }, []);

  const markSeen = useCallback((id: string) => {
    if (!id) return;
    setSeenIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      persistSeenIds(next);
      return next;
    });
  }, []);

  const isSeen = useCallback((id: string) => seenIds.has(id), [seenIds]);

  return { seenIds, markSeen, isSeen };
}
