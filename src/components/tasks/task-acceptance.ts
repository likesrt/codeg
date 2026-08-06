import type { WorkTask } from "@/lib/types"

/**
 * Whether a reviewed task has nothing for a merge to take: when the run
 * settled, the engine diffed its worktree against the recorded base and found
 * no changed file.
 *
 * Only `0` counts — `null` means the engine could not read the stats (no
 * worktree, unreadable base), and merging stays the safe default there. The
 * board uses this to offer "complete" in place of "merge"; the engine re-runs
 * the same diff before it finishes the task, so a stale card cannot drop work.
 */
export function hasNothingToMerge(task: WorkTask): boolean {
  return task.status === "review" && task.files_changed === 0
}
