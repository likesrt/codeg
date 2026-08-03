"use client"

const BOARD_FILTER_KEY = "workspace:tasks-board-filter"

/** Visibility toggles of the tasks board's filter popover. */
export interface TasksBoardFilter {
  showCanceled: boolean
  showArchived: boolean
}

/** Default view: canceled tasks visible, archived ones hidden. */
export const DEFAULT_TASKS_BOARD_FILTER: TasksBoardFilter = {
  showCanceled: true,
  showArchived: false,
}

export function loadTasksBoardFilter(): TasksBoardFilter {
  if (typeof window === "undefined") return DEFAULT_TASKS_BOARD_FILTER
  try {
    const raw = localStorage.getItem(BOARD_FILTER_KEY)
    if (!raw) return DEFAULT_TASKS_BOARD_FILTER
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return DEFAULT_TASKS_BOARD_FILTER
    const obj = parsed as Record<string, unknown>
    return {
      showCanceled:
        typeof obj.showCanceled === "boolean"
          ? obj.showCanceled
          : DEFAULT_TASKS_BOARD_FILTER.showCanceled,
      showArchived:
        typeof obj.showArchived === "boolean"
          ? obj.showArchived
          : DEFAULT_TASKS_BOARD_FILTER.showArchived,
    }
  } catch {
    return DEFAULT_TASKS_BOARD_FILTER
  }
}

export function saveTasksBoardFilter(filter: TasksBoardFilter): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(BOARD_FILTER_KEY, JSON.stringify(filter))
  } catch {
    /* ignore */
  }
}
