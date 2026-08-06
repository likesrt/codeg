import { parseTimestamp } from "@/components/conversations/sidebar-conversation-grouping"
import type { WorkTask, WorkTaskStatus } from "@/lib/types"

/** The four board columns (DB statuses are exact; the UI aggregates them). */
export type BoardColumnId = "todo" | "inProgress" | "attention" | "done"

export const BOARD_COLUMN_IDS: BoardColumnId[] = [
  "todo",
  "inProgress",
  "attention",
  "done",
]

/**
 * DB status → board column. `canceled` lives in the Done column but is hidden
 * unless the "show canceled" toggle is on (filtered by `groupTasksByColumn`).
 */
export function columnForStatus(status: WorkTaskStatus): BoardColumnId {
  switch (status) {
    case "todo":
    // Still waiting for a concurrency slot — nothing is happening yet.
    case "queued":
      return "todo"
    // Already out of the queue and working (worktree, init command, agent
    // spawn), just without a session to show yet.
    case "preparing":
    case "running":
      return "inProgress"
    case "awaiting_input":
    case "review":
    // A merge is an agent turn, but the card must not bounce across the
    // board when the user clicks merge — it stays in the review column and
    // moves straight to Done when the merge lands.
    case "merging":
    case "failed":
      return "attention"
    case "done":
    case "canceled":
      return "done"
  }
}

/**
 * Bucket tasks into the four columns. Canceled tasks are dropped unless
 * `showCanceled`, archived ones unless `showArchived` (archived is always
 * terminal).
 *
 * Every column reads freshest-first: `updated_at` descending, so whatever just
 * moved sits at the top of its column. The sort is stable and the backend hands
 * rows over in board order (sort_order, id), so equal timestamps keep that
 * order — which is exactly what preserves a pending-column drag: `reorder`
 * stamps the whole column with one `updated_at`, the rows tie, and the fallback
 * is their freshly written sort_order. sort_order still drives the launch queue
 * (`next_queued` / "start all"); it just no longer drives the display.
 */
export function groupTasksByColumn(
  tasks: WorkTask[],
  showCanceled: boolean,
  showArchived = false
): Record<BoardColumnId, WorkTask[]> {
  const grouped: Record<BoardColumnId, WorkTask[]> = {
    todo: [],
    inProgress: [],
    attention: [],
    done: [],
  }
  for (const task of tasks) {
    if (task.status === "canceled" && !showCanceled) continue
    if (task.archived_at != null && !showArchived) continue
    grouped[columnForStatus(task.status)].push(task)
  }
  for (const column of BOARD_COLUMN_IDS) {
    grouped[column].sort(
      (a, b) => parseTimestamp(b.updated_at) - parseTimestamp(a.updated_at)
    )
  }
  return grouped
}
