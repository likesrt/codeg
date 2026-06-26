"use client"

import { useEffect, useMemo, useState } from "react"

import {
  expertsListAllInstallStatuses,
  officecliSkillListAllInstallStatuses,
} from "@/lib/api"
import type { AgentType, ExpertInstallStatus } from "@/lib/types"

// Module-level cache shared across QuickActions mounts. The snapshots are
// agent-agnostic (one entry per (skill, agent) pair), so switching the selected
// agent only re-filters in memory — no refetch. Refreshed on window focus to
// pick up enable/disable performed in the settings window.
let cached: ExpertInstallStatus[] | null = null
let inflight: Promise<ExpertInstallStatus[] | null> | null = null
// Bumped on every invalidation (focus). A load whose generation is stale by the
// time it resolves must not overwrite a fresher snapshot — guards the
// focus-refetch race where an orphaned earlier request resolves last.
let generation = 0
const subscribers = new Set<(snapshot: ExpertInstallStatus[]) => void>()

/**
 * Load the experts + office-tools install-status snapshots and merge them.
 *
 * Fails *open*: if either request rejects, we keep (and return) the previous
 * cached snapshot rather than substituting an empty list. That matters because
 * a locked card blocks injection — turning a transient backend error into an
 * empty snapshot would make every skill look "not enabled" and wrongly block
 * skills the user actually enabled. With no prior snapshot the result stays
 * `null`, so `ready` remains false and callers treat everything as usable
 * (the pre-gating behavior) instead of locking it all.
 */
async function loadSnapshot(): Promise<ExpertInstallStatus[] | null> {
  if (inflight) return inflight
  const myGeneration = generation
  inflight = Promise.all([
    expertsListAllInstallStatuses(),
    officecliSkillListAllInstallStatuses(),
  ])
    .then(([experts, office]) => {
      inflight = null
      // A newer invalidation superseded this request while it was in flight —
      // discard its result so it can't clobber the fresher snapshot.
      if (myGeneration !== generation) return cached
      const merged = [...experts, ...office]
      cached = merged
      for (const notify of subscribers) notify(merged)
      return merged
    })
    .catch((err) => {
      inflight = null
      console.warn("[useEnabledSkillIds] failed to load statuses:", err)
      return cached
    })
  return inflight
}

/**
 * Returns the set of skill ids (built-in experts + office tools) currently
 * enabled — i.e. symlinked into the given agent's skill directory — for the
 * passed agent. Mirrors the settings page's "enabled" definition: a
 * `(skillId, agentType)` pair counts as enabled only when its install status is
 * `linked_to_codeg`.
 *
 * `ready` is false until the first snapshot resolves successfully, so callers
 * can avoid marking everything as "not enabled" during the initial async load
 * (or after an error, where we deliberately stay not-ready and fail open).
 */
export function useEnabledSkillIds(agentType: AgentType | null): {
  enabledIds: Set<string>
  ready: boolean
} {
  const [snapshot, setSnapshot] = useState<ExpertInstallStatus[] | null>(
    () => cached
  )

  // Initial load + subscribe for updates (covers the focus refetch below and
  // any concurrent QuickActions instance resolving the shared fetch first).
  // Only adopt a non-null result: a null means "load failed / not loaded yet",
  // and overwriting a good local snapshot with null would needlessly drop us
  // back to not-ready.
  useEffect(() => {
    let cancelled = false
    if (!cached) {
      loadSnapshot().then((next) => {
        if (!cancelled && next) setSnapshot(next)
      })
    }
    const onUpdate = (next: ExpertInstallStatus[]) => {
      if (!cancelled) setSnapshot(next)
    }
    subscribers.add(onUpdate)
    return () => {
      cancelled = true
      subscribers.delete(onUpdate)
    }
  }, [])

  // Re-fetch when the window regains focus — the settings window links/unlinks
  // skills while this conversation window stays mounted. Bump the generation
  // and clear the in-flight handle so a fresh request runs; the resolve
  // notifies every subscriber (no direct setState here, so the lint rule
  // against state-in-effect stays satisfied). On failure the cache is kept, so
  // a transient error never resets a good snapshot.
  useEffect(() => {
    const onFocus = () => {
      generation += 1
      inflight = null
      loadSnapshot()
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [])

  const enabledIds = useMemo(() => {
    const set = new Set<string>()
    if (!snapshot || !agentType) return set
    for (const status of snapshot) {
      if (
        status.agentType === agentType &&
        status.state === "linked_to_codeg"
      ) {
        set.add(status.expertId)
      }
    }
    return set
  }, [snapshot, agentType])

  return { enabledIds, ready: snapshot !== null }
}
