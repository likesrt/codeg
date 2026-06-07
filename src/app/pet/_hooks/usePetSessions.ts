"use client"

import { useEffect, useState } from "react"
import { listActivePetSessions } from "@/lib/pet/api"
import { getTransport } from "@/lib/transport"
import type { PetSessionsPayload } from "@/lib/pet/types"

const PET_SESSIONS_EVENT = "pet://sessions"

const EMPTY: PetSessionsPayload = {
  runningCount: 0,
  waitingCount: 0,
  errorCount: 0,
  sessions: [],
}

/**
 * Subscribe to the backend-owned `pet://sessions` stream and recover the
 * current snapshot on mount. Mirrors {@link usePetState}'s
 * subscribe-then-snapshot shape: the aggregator only emits on change, so a
 * window/panel that mounts mid-conversation needs the snapshot to fill the
 * gap — but a live event that races in first must not be clobbered by the
 * (now stale) snapshot.
 *
 * Returns the full payload so both the sprite badge (counts only) and the
 * panel (full list) can share one subscription path.
 */
export function usePetSessions(): PetSessionsPayload {
  const [payload, setPayload] = useState<PetSessionsPayload>(EMPTY)

  useEffect(() => {
    let unlisten: (() => void) | null = null
    let cancelled = false
    let liveEventSeen = false

    const applyLive = (next: PetSessionsPayload | null) => {
      if (cancelled || !next) return
      liveEventSeen = true
      setPayload(next)
    }

    void (async () => {
      try {
        const off = await getTransport().subscribe<PetSessionsPayload>(
          PET_SESSIONS_EVENT,
          (raw) => applyLive(normalize(raw))
        )
        if (cancelled) {
          off()
          return
        }
        unlisten = off

        // Subscription armed — pull the current snapshot for windows that
        // mounted after the last emit. If a live event raced in first, keep it.
        try {
          const snapshot = await listActivePetSessions()
          if (!cancelled && !liveEventSeen) setPayload(snapshot)
        } catch (err) {
          console.warn("[Pet] sessions snapshot fetch failed:", err)
        }
      } catch (err) {
        // Non-fatal: badge/panel just stay empty.
        console.warn("[Pet] sessions subscription failed:", err)
      }
    })()

    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [])

  return payload
}

/** Unwrap a possible `{ payload: {...} }` transport envelope and validate the
 *  shape so callers can't be handed a non-payload value. */
function normalize(raw: unknown): PetSessionsPayload | null {
  let obj = raw
  if (
    obj &&
    typeof obj === "object" &&
    "payload" in obj &&
    !("sessions" in obj)
  ) {
    obj = (obj as { payload: unknown }).payload
  }
  if (
    obj &&
    typeof obj === "object" &&
    Array.isArray((obj as PetSessionsPayload).sessions)
  ) {
    return obj as PetSessionsPayload
  }
  return null
}
