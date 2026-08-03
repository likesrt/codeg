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
    case "queued":
      return "todo"
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
 * Bucket tasks into the four columns, preserving list order (backend returns
 * board order: sort_order, id). Canceled tasks are dropped unless
 * `showCanceled`, archived ones unless `showArchived` (archived is always
 * terminal); done tasks sort before canceled within the Done column.
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
  grouped.done.sort((a, b) => {
    const aCanceled = a.status === "canceled" ? 1 : 0
    const bCanceled = b.status === "canceled" ? 1 : 0
    if (aCanceled !== bCanceled) return aCanceled - bCanceled
    // Freshest completion first within each group.
    return (b.finished_at ?? "").localeCompare(a.finished_at ?? "")
  })
  return grouped
}
