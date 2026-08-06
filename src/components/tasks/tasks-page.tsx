"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import { Reorder, type PanInfo } from "motion/react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Folder, Funnel, Play, Plus, Settings2, ListTodo } from "lucide-react"
import { useTasksView } from "@/contexts/tasks-view-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  workTaskArchive,
  workTaskCreate,
  workTaskReorder,
  workTaskStart,
  workTaskStartAll,
  workTaskUpdate,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  consumePendingTaskDraft,
  CREATE_TASK_FROM_TEXT_EVENT,
  type CreateTaskFromTextDetail,
} from "@/lib/task-compose-events"
import {
  DEFAULT_TASKS_BOARD_FILTER,
  loadTasksBoardFilter,
  saveTasksBoardFilter,
} from "@/lib/tasks-board-filter-storage"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  BOARD_COLUMN_IDS,
  groupTasksByColumn,
  type BoardColumnId,
} from "./board-columns"
import { TaskCancelDialog } from "./task-cancel-dialog"
import { StatusChip, TaskCard } from "./task-card"
import { TaskCompleteDialog } from "./task-complete-dialog"
import { TaskDetailSheet } from "./task-detail-sheet"
import { TaskEditorDialog } from "./task-editor-dialog"
import { TaskMergeDialog } from "./task-merge-dialog"
import { TaskRestartDialog, type TaskRestartKind } from "./task-restart-dialog"
import { TaskSettingsDialog } from "./task-settings-dialog"
import { TaskTranscriptDialog } from "./task-transcript-dialog"
import type { WorkTask, WorkTaskDraft } from "@/lib/types"

const COLUMN_LABEL_KEYS = {
  todo: "colTodo",
  inProgress: "colInProgress",
  attention: "colAttention",
  done: "colDone",
} as const satisfies Record<BoardColumnId, string>

const EMPTY_LABEL_KEYS = {
  todo: "emptyColTodo",
  inProgress: "emptyColInProgress",
  attention: "emptyColAttention",
  done: "emptyColDone",
} as const satisfies Record<BoardColumnId, string>

const ALL_FOLDERS = "__all__"

/** The cards inside a column. gap-4 — the same gutter the columns keep from
 *  each other and from the window edge — so a card is inset by 1rem on all
 *  four sides instead of being packed tighter vertically than horizontally.
 *  pb-1 keeps the last card clear of the scroll area's edge. */
const CARD_LIST_CLASS = "flex flex-col gap-4 pb-1"

/** Fired by the chrome-strip settings button; TasksPage owns the dialog (and
 *  the folder filter that scopes it), so the strip just asks it to open. */
const OPEN_TASK_SETTINGS_EVENT = "codeg:open-task-settings"

/** Page title rendered into the window-chrome strip above the page (the h-10
 *  band shared with the fixed corner overlays) — sized like the surrounding
 *  window-chrome controls, with the settings entry right after the title. */
export function TasksPageTitle() {
  const t = useTranslations("Tasks")
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 pl-4">
      <h1 className="flex items-center gap-1.5 text-[0.8125rem] font-semibold leading-none">
        <ListTodo className="size-4 text-muted-foreground" aria-hidden="true" />
        {t("title")}
        {/* Untranslated on purpose: "Beta" reads as-is in every locale we
            ship, and it is a release-stage marker, not prose. */}
        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase leading-none tracking-wide text-primary">
          Beta
        </span>
      </h1>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 gap-1.5 rounded-md px-2 text-xs font-normal text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        onClick={() =>
          window.dispatchEvent(new Event(OPEN_TASK_SETTINGS_EVENT))
        }
      >
        <Settings2 className="size-3.5" aria-hidden="true" />
        {t("settingsTitle")}
      </Button>
    </div>
  )
}

/**
 * The Tasks route page: toolbar (folder filter, filter popover, settings,
 * start all, new task — the page title lives in the chrome strip above) and
 * the four-column board. Data comes from the always-mounted TasksViewProvider;
 * every mutation is fire-and-refetch — the engine's `task://changed` nudges
 * keep all clients converged.
 */
export function TasksPage() {
  const t = useTranslations("Tasks")
  const { tasks, refetch } = useTasksView()
  const folders = useAppWorkspaceStore((s) => s.folders)
  const projectFolders = useMemo(
    () => folders.filter((f) => f.parent_id == null && f.kind === "regular"),
    [folders]
  )
  const folderNames = useMemo(() => {
    const map = new Map<number, string>()
    for (const f of folders) map.set(f.id, f.alias ?? f.name)
    return map
  }, [folders])

  const [folderFilter, setFolderFilter] = useState<number | null>(null)
  // Restored synchronously from localStorage: this page mounts only after a
  // client-side route switch (never prerendered), so there is no SSR markup to
  // mismatch — and the board paints with the remembered filter right away.
  const [boardFilter, setBoardFilter] = useState(loadTasksBoardFilter)
  useEffect(() => {
    saveTasksBoardFilter(boardFilter)
  }, [boardFilter])
  // Dragging a pending card is always available: dropping it on In-progress
  // starts the task and needs no order at all. Only the REORDER half waits on
  // a folder — sort_order is per folder, so a mixed-folder列 has nothing it
  // could persist, and the cards simply don't shuffle there.
  const [dragOrder, setDragOrder] = useState<number[] | null>(null)
  const dragOrderRef = useRef<number[] | null>(null)
  dragOrderRef.current = dragOrder
  const inProgressColRef = useRef<HTMLDivElement | null>(null)
  // A drop acts on the LIVE row, not the snapshot the drag started from: the
  // provider refetches throughout a drag, and the engine's auto-processor can
  // claim a pending task while it is in the air.
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  // The dragged card cannot visually leave its column — the column is a scroll
  // area, so it clips — which made the drop read as impossible even though it
  // worked. A fixed-position preview follows the pointer instead, portalled
  // clear of every clipping and transformed ancestor.
  const [drag, setDrag] = useState<{ task: WorkTask; width: number } | null>(
    null
  )
  const [dropArmed, setDropArmed] = useState(false)
  const dropArmedRef = useRef(false)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  // Grab offset inside the card and the card's width, both read at pointerdown
  // (the drag events' native `currentTarget` is gone by the time they fire),
  // so the preview appears exactly over the card and tracks the pointer 1:1.
  const grabRef = useRef({ dx: 0, dy: 0, width: 0 })
  const pointRef = useRef({ x: 0, y: 0 })
  // A drag ends with a click on the card underneath; without this latch the
  // detail sheet would open on top of whatever the drop just did.
  const draggedRef = useRef(false)
  // Set when the gesture ended without a deliberate release (see abortDrag).
  const dragAbortedRef = useRef(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorTask, setEditorTask] = useState<WorkTask | null>(null)
  const [editorPrefill, setEditorPrefill] =
    useState<CreateTaskFromTextDetail | null>(null)

  // One shared timestamp per render tick keeps every card's relative-time
  // label consistent; a minute interval bounds staleness.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  // "Task from message" hand-off: consume the parked draft on mount (this page
  // is unmounted while other routes are active) and on the live event.
  useEffect(() => {
    const consume = () => {
      const draft = consumePendingTaskDraft()
      if (!draft) return
      setEditorTask(null)
      setEditorPrefill(draft)
      setEditorOpen(true)
    }
    consume()
    window.addEventListener(CREATE_TASK_FROM_TEXT_EVENT, consume)
    return () =>
      window.removeEventListener(CREATE_TASK_FROM_TEXT_EVENT, consume)
  }, [])
  const [detailTaskId, setDetailTaskId] = useState<number | null>(null)
  const [mergeTask, setMergeTask] = useState<WorkTask | null>(null)
  const [mergeOpen, setMergeOpen] = useState(false)
  // The merge dialog's counterpart for a task that changed nothing.
  const [completeTask, setCompleteTask] = useState<WorkTask | null>(null)
  const [completeOpen, setCompleteOpen] = useState(false)
  // Stopping a task asks why (optional) — from the card and from the drawer.
  const [cancelTask, setCancelTask] = useState<WorkTask | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)
  // Restarting from a card asks for an optional note; the drawer unfolds its
  // own box in place instead.
  const [restartTask, setRestartTask] = useState<WorkTask | null>(null)
  const [restartKind, setRestartKind] = useState<TaskRestartKind>("retry")
  const [restartOpen, setRestartOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Read-only live session viewer ("查看会话") — tracked by id so the dialog
  // header's status chip follows the live row (like the detail sheet).
  const [sessionTaskId, setSessionTaskId] = useState<number | null>(null)
  const [sessionOpen, setSessionOpen] = useState(false)

  // The settings entry lives in the chrome strip (TasksPageTitle), a separate
  // tree branch — it asks this page (which owns the dialog + folder scope) to
  // open via a window event, like the "task from message" hand-off above.
  useEffect(() => {
    const open = () => setSettingsOpen(true)
    window.addEventListener(OPEN_TASK_SETTINGS_EVENT, open)
    return () => window.removeEventListener(OPEN_TASK_SETTINGS_EVENT, open)
  }, [])

  const visibleTasks = useMemo(
    () =>
      folderFilter == null
        ? tasks
        : tasks.filter((task) => task.folder_id === folderFilter),
    [tasks, folderFilter]
  )
  const columns = useMemo(
    () =>
      groupTasksByColumn(
        visibleTasks,
        boardFilter.showCanceled,
        boardFilter.showArchived
      ),
    [visibleTasks, boardFilter]
  )
  const dragEnabled = folderFilter != null
  // Optimistic order while a drag is live; server order otherwise.
  const todoTasks = useMemo(() => {
    const base = columns.todo
    if (!dragEnabled || dragOrder == null) return base
    const byId = new Map(base.map((task) => [task.id, task]))
    const ordered = dragOrder.flatMap((id) => byId.get(id) ?? [])
    for (const task of base) {
      if (!dragOrder.includes(task.id)) ordered.push(task)
    }
    return ordered
  }, [columns.todo, dragEnabled, dragOrder])
  // The sheet renders the LIVE row from the provider so status flips (e.g.
  // merging → done) update in place while it is open.
  const detailTask = useMemo(
    () => tasks.find((task) => task.id === detailTaskId) ?? null,
    [tasks, detailTaskId]
  )
  const sessionTask = useMemo(
    () => tasks.find((task) => task.id === sessionTaskId) ?? null,
    [tasks, sessionTaskId]
  )

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn()
      } catch (e) {
        toast.error(toErrorMessage(e))
      } finally {
        void refetch()
      }
    },
    [refetch]
  )

  const openSession = useCallback((task: WorkTask) => {
    if (task.conversation_id == null) return
    setSessionTaskId(task.id)
    setSessionOpen(true)
  }, [])

  const submitEditor = useCallback(
    async (draft: WorkTaskDraft) => {
      if (editorTask) await workTaskUpdate(editorTask.id, draft)
      else await workTaskCreate(draft)
      setEditorOpen(false)
      setEditorPrefill(null)
      void refetch()
    },
    [editorTask, refetch]
  )

  const openMerge = useCallback((task: WorkTask) => {
    setMergeTask(task)
    setMergeOpen(true)
  }, [])

  const openComplete = useCallback((task: WorkTask) => {
    setCompleteTask(task)
    setCompleteOpen(true)
  }, [])

  const openCancel = useCallback((task: WorkTask) => {
    setCancelTask(task)
    setCancelOpen(true)
  }, [])

  const openRestart = useCallback((task: WorkTask, kind: TaskRestartKind) => {
    setRestartTask(task)
    setRestartKind(kind)
    setRestartOpen(true)
  }, [])

  const openNewTask = useCallback(() => {
    setEditorTask(null)
    setEditorOpen(true)
  }, [])

  const positionGhost = useCallback((x: number, y: number) => {
    const el = ghostRef.current
    if (!el) return
    const { dx, dy } = grabRef.current
    el.style.transform = `translate3d(${x - dx}px, ${y - dy}px, 0)`
  }, [])

  // Place the preview before its first paint, so it never flashes at the
  // window's top-left corner on the frame it mounts.
  useLayoutEffect(() => {
    if (drag) positionGhost(pointRef.current.x, pointRef.current.y)
  }, [drag, positionGhost])

  const pointerOverInProgress = (x: number, y: number) => {
    const rect = inProgressColRef.current?.getBoundingClientRect()
    return (
      rect != null &&
      x >= rect.left &&
      x <= rect.right &&
      y >= rect.top &&
      y <= rect.bottom
    )
  }

  // Read the grab geometry here rather than in onDragStart: the drag events
  // carry a native pointer event whose `currentTarget` is already gone.
  const handleTodoPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    grabRef.current = {
      dx: e.clientX - rect.left,
      dy: e.clientY - rect.top,
      width: rect.width,
    }
  }

  const handleTodoDragStart = (task: WorkTask, info: PanInfo) => {
    draggedRef.current = true
    dragAbortedRef.current = false
    pointRef.current = { x: info.point.x, y: info.point.y }
    setDrag({ task, width: grabRef.current.width })
  }

  // Pointer-rate: the preview moves by direct style mutation and only the
  // drop-target flip goes through state.
  const handleTodoDrag = (info: PanInfo) => {
    pointRef.current = { x: info.point.x, y: info.point.y }
    positionGhost(info.point.x, info.point.y)
    const over = pointerOverInProgress(info.point.x, info.point.y)
    if (over !== dropArmedRef.current) {
      dropArmedRef.current = over
      setDropArmed(over)
    }
  }

  // `latchNow` clears the post-drag click latch immediately instead of after a
  // frame: only a deliberate release is followed by a click.
  const clearDrag = useCallback((latchNow: boolean) => {
    setDrag(null)
    setDropArmed(false)
    dropArmedRef.current = false
    if (latchNow) {
      draggedRef.current = false
      return
    }
    // The click that ends the drag lands before the next frame.
    requestAnimationFrame(() => {
      draggedRef.current = false
    })
  }, [])

  // A gesture can end without a deliberate drop: the OS cancels it (touch), the
  // window loses focus with the button still held, or the card unmounts because
  // something claimed the task while it was in the air. Motion reports the
  // first case through the same `onDragEnd` as a real release and the last one
  // not at all — so the preview and the click latch have to be torn down here,
  // and the drop itself must not run.
  const abortDrag = useCallback(() => {
    dragAbortedRef.current = true
    setDragOrder(null)
    clearDrag(true)
  }, [clearDrag])

  useEffect(() => {
    if (!drag) return
    const onVisibility = () => {
      if (document.hidden) abortDrag()
    }
    window.addEventListener("blur", abortDrag)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("blur", abortDrag)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [drag, abortDrag])

  // The dragged card left the pending column under us — its Reorder.Item
  // unmounts with it and Motion never reports an end, which would strand the
  // preview and leave the latch swallowing every card click.
  useEffect(() => {
    if (drag && !todoTasks.some((task) => task.id === drag.task.id)) {
      abortDrag()
    }
  }, [drag, todoTasks, abortDrag])

  // Drop on the In-progress column = start (the card itself drags on the y
  // axis, but the POINTER is free — droppedness is judged by its position).
  // Anywhere else = persist the reorder, when there is one to persist.
  const handleTodoDragEnd = useCallback(
    (task: WorkTask, event: unknown, info: PanInfo) => {
      // `pointercancel` routes through Motion's pointer-up handler, so an
      // abandoned gesture arrives here looking exactly like a release.
      const aborted =
        dragAbortedRef.current ||
        (event as Event | null | undefined)?.type === "pointercancel"
      clearDrag(aborted)
      if (aborted) {
        setDragOrder(null)
        return
      }
      const rect = inProgressColRef.current?.getBoundingClientRect()
      const droppedOnInProgress =
        rect != null &&
        info.point.x >= rect.left &&
        info.point.x <= rect.right &&
        info.point.y >= rect.top &&
        info.point.y <= rect.bottom
      if (droppedOnInProgress) {
        setDragOrder(null)
        // The row may have advanced during the drag; the engine would reject
        // the stale start anyway, so don't spend a request and a toast on it.
        const live = tasksRef.current.find((row) => row.id === task.id)
        if (live?.status === "todo") void act(() => workTaskStart(task.id))
        return
      }
      const order = dragOrderRef.current
      if (folderFilter != null && order != null) {
        void (async () => {
          try {
            await workTaskReorder(folderFilter, order)
          } catch (e) {
            toast.error(toErrorMessage(e))
          }
          await refetch()
          setDragOrder(null)
        })()
      }
    },
    [act, clearDrag, folderFilter, refetch]
  )

  // With "all folders" selected this is the global sweep — every folder that
  // holds todos gets its own claim + pump.
  const startAll = useCallback(() => {
    void act(async () => {
      const claimed = await workTaskStartAll(folderFilter)
      if (claimed > 0) toast.success(t("toastStartedAll", { count: claimed }))
      else toast.info(t("toastNothingToStart"))
    })
  }, [act, folderFilter, t])

  // Archives whatever the Done column currently shows unarchived — respects
  // the visibility toggles by construction (it reads the grouped column).
  const archiveAllDone = useCallback(() => {
    const targets = columns.done.filter((task) => task.archived_at == null)
    if (targets.length === 0) return
    void act(() =>
      Promise.all(targets.map((task) => workTaskArchive(task.id, true)))
    )
  }, [act, columns.done])

  // The badge counts deviations from the DEFAULT view (canceled shown,
  // archived hidden), not checked boxes — a pristine board shows no badge.
  const activeFilters =
    (boardFilter.showCanceled === DEFAULT_TASKS_BOARD_FILTER.showCanceled
      ? 0
      : 1) +
    (boardFilter.showArchived === DEFAULT_TASKS_BOARD_FILTER.showArchived
      ? 0
      : 1)
  const hasAnyTask = tasks.length > 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar (the page title renders in the chrome strip above the page,
          which owns the divider — the toolbar itself is borderless).
          pt-4 / px-4, not py-2: the pills clear the title bar by the same 1rem
          they clear the window's left edge, and pb-2 plus the board's own pt-2
          makes the gap underneath 1rem too — the row sits on one inset.

          Withheld until the first task exists: on an empty board every control
          here filters or starts nothing, and the only action that does
          anything — "new task" — is already the empty state's own button. */}
      {hasAnyTask && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-2 pt-4">
          <Select
            value={folderFilter == null ? ALL_FOLDERS : String(folderFilter)}
            onValueChange={(v) =>
              setFolderFilter(v === ALL_FOLDERS ? null : Number(v))
            }
          >
            {/* Leads with a folder glyph like the Automations filter pill: "全部
                文件夹" alone doesn't say WHICH axis the pill filters. */}
            <SelectTrigger
              size="sm"
              className="h-8 w-auto min-w-0 max-w-[14rem] gap-1.5 rounded-full border-transparent bg-muted/70 px-3 text-[0.8125rem] font-medium shadow-none ws-msg-chip hover:bg-muted"
            >
              <Folder
                className="size-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_FOLDERS}>{t("allFolders")}</SelectItem>
              {projectFolders.map((f) => (
                <SelectItem key={f.id} value={String(f.id)}>
                  {f.alias ?? f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Same pill treatment as the folder select so the left cluster reads
              as one family of controls (the settings entry lives in the chrome
              strip next to the page title). */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 rounded-full bg-muted/70 px-3 text-[0.8125rem] font-medium ws-msg-chip hover:bg-muted"
              >
                <Funnel
                  className="size-3.5 text-muted-foreground"
                  aria-hidden="true"
                />
                {t("filter")}
                {activeFilters > 0 ? (
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[0.625rem] font-medium leading-none text-primary tabular-nums">
                    {activeFilters}
                  </span>
                ) : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-52 gap-0.5 rounded-xl p-1.5"
            >
              <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-accent/50">
                <Checkbox
                  checked={boardFilter.showCanceled}
                  onCheckedChange={(v) =>
                    setBoardFilter((f) => ({ ...f, showCanceled: v === true }))
                  }
                />
                {t("showCanceled")}
              </label>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-accent/50">
                <Checkbox
                  checked={boardFilter.showArchived}
                  onCheckedChange={(v) =>
                    setBoardFilter((f) => ({ ...f, showArchived: v === true }))
                  }
                />
                {t("showArchived")}
              </label>
            </PopoverContent>
          </Popover>

          <div className="flex-1" />

          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5 rounded-full px-3 text-[0.8125rem]"
            onClick={startAll}
          >
            <Play className="size-3.5" aria-hidden="true" />
            {t("startAll")}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 gap-1 rounded-full px-3.5 text-[0.8125rem]"
            onClick={openNewTask}
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("new")}
          </Button>
        </div>
      )}

      {/* Board */}
      {!hasAnyTask ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <ListTodo
            className="size-10 text-muted-foreground/40"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{t("empty")}</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {t("emptyHint")}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            onClick={openNewTask}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {t("new")}
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-x-auto">
          {/* pt-1, not p-4's 16px: the column headers belong to the toolbar
              above, not to the cards below. It also evens out the folder
              pill's optical margins — 8px of the toolbar's pb-2 plus this 4px
              plus the header row's own ~4px of leading slack comes to the same
              1rem the pill keeps above itself. */}
          <div className="grid h-full min-w-[56rem] grid-cols-4 gap-4 px-4 pb-4 pt-1">
            {BOARD_COLUMN_IDS.map((col) => {
              const colTasks = col === "todo" ? todoTasks : columns[col]
              const cardFor = (task: WorkTask) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  folderName={folderNames.get(task.folder_id) ?? null}
                  now={now}
                  onOpen={() => {
                    // Swallow the click that closes a drag.
                    if (draggedRef.current) return
                    setDetailTaskId(task.id)
                  }}
                  onStart={() => void act(() => workTaskStart(task.id))}
                  onCancel={() => openCancel(task)}
                  onRetry={() => openRestart(task, "retry")}
                  onRequeue={() => openRestart(task, "requeue")}
                  onViewSession={() => openSession(task)}
                  onMerge={() => openMerge(task)}
                  onComplete={() => openComplete(task)}
                  onArchive={() =>
                    void act(() =>
                      workTaskArchive(task.id, task.archived_at == null)
                    )
                  }
                  onEdit={() => {
                    setEditorTask(task)
                    setEditorOpen(true)
                  }}
                />
              )
              return (
                <div
                  key={col}
                  ref={col === "inProgress" ? inProgressColRef : undefined}
                  className="flex min-h-0 flex-col gap-2"
                >
                  <div className="flex h-6 shrink-0 items-center gap-2 px-0.5">
                    {/* A short upright bar rather than a dot: it echoes the
                        column it heads (and the pill radius of the toolbar
                        above), and it reads as a marker instead of a bullet.
                        Same tones as before. */}
                    <span
                      className={cn(
                        "h-3.5 w-[3px] shrink-0 rounded-full",
                        col === "todo" && "bg-muted-foreground/50",
                        col === "inProgress" && "bg-primary",
                        col === "attention" && "bg-amber-500",
                        col === "done" && "bg-emerald-500"
                      )}
                      aria-hidden="true"
                    />
                    <h2 className="text-xs font-semibold">
                      {t(COLUMN_LABEL_KEYS[col])}
                    </h2>
                    {/* The count is a pill in the toolbar's muted-pill
                        language, so the two header rows read as one block. */}
                    {col === "attention" && colTasks.length > 0 ? (
                      <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[0.625rem] font-semibold leading-none text-amber-600 tabular-nums dark:text-amber-400">
                        {colTasks.length}
                      </span>
                    ) : (
                      <span className="rounded-full bg-muted/70 px-1.5 py-0.5 text-[0.625rem] font-medium leading-none text-muted-foreground tabular-nums">
                        {colTasks.length}
                      </span>
                    )}
                    <div className="flex-1" />
                    {col === "done" &&
                    columns.done.some((task) => task.archived_at == null) ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        className="px-1.5 font-normal text-muted-foreground hover:text-foreground"
                        onClick={archiveAllDone}
                      >
                        {t("archiveAllDone")}
                      </Button>
                    ) : null}
                  </div>
                  {colTasks.length === 0 ? (
                    <div
                      className={cn(
                        // border-border is near-invisible on the plain canvas —
                        // dash with a foreground-derived tone instead.
                        "flex flex-1 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-muted-foreground/30 p-4 text-center",
                        // Drop target while a pending card is dragged: quiet
                        // once the drag starts, loud once the pointer is
                        // actually inside. Otherwise tint like the cards when a
                        // workspace background image is on (ws-msg-card is
                        // inert without one) so the cell stays legible over a
                        // photo.
                        col === "inProgress" && drag
                          ? dropArmed
                            ? "border-primary bg-primary/10"
                            : "border-primary/40"
                          : "ws-msg-card"
                      )}
                    >
                      <p className="text-xs text-muted-foreground">
                        {t(EMPTY_LABEL_KEYS[col])}
                      </p>
                    </div>
                  ) : (
                    <ScrollArea
                      className={cn(
                        "min-h-0 flex-1 rounded-xl transition-colors",
                        col === "inProgress" &&
                          drag &&
                          (dropArmed
                            ? "bg-primary/5 ring-2 ring-primary"
                            : "ring-1 ring-primary/25")
                      )}
                    >
                      {col === "todo" ? (
                        <Reorder.Group
                          as="div"
                          axis="y"
                          values={todoTasks.map((task) => task.id)}
                          // Without a folder there is no order to save, so the
                          // cards stay put and the drag exists only to start.
                          onReorder={(ids: number[]) => {
                            if (dragEnabled) setDragOrder(ids)
                          }}
                          className={CARD_LIST_CLASS}
                        >
                          {todoTasks.map((task) => (
                            <Reorder.Item
                              key={task.id}
                              value={task.id}
                              as="div"
                              onPointerDown={handleTodoPointerDown}
                              onDragStart={(_e: unknown, info: PanInfo) =>
                                handleTodoDragStart(task, info)
                              }
                              onDrag={(_e: unknown, info: PanInfo) =>
                                handleTodoDrag(info)
                              }
                              onDragEnd={(e: unknown, info: PanInfo) =>
                                handleTodoDragEnd(task, e, info)
                              }
                              className={cn(
                                "cursor-grab active:cursor-grabbing",
                                // The preview is the card now; what stays in
                                // the list is the slot it came from.
                                drag?.task.id === task.id && "opacity-40"
                              )}
                            >
                              {cardFor(task)}
                            </Reorder.Item>
                          ))}
                        </Reorder.Group>
                      ) : (
                        <div className={CARD_LIST_CLASS}>
                          {colTasks.map(cardFor)}
                        </div>
                      )}
                    </ScrollArea>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <TaskEditorDialog
        open={editorOpen}
        onOpenChange={(o) => {
          setEditorOpen(o)
          if (!o) setEditorPrefill(null)
        }}
        task={editorTask}
        defaultFolderId={editorPrefill?.folderId ?? folderFilter}
        prefillText={editorPrefill?.text ?? null}
        onSubmit={submitEditor}
      />
      <TaskDetailSheet
        open={detailTaskId != null}
        onOpenChange={(o) => {
          if (!o) setDetailTaskId(null)
        }}
        task={detailTask}
        folderName={
          detailTask ? (folderNames.get(detailTask.folder_id) ?? null) : null
        }
        onViewSession={openSession}
        onMerge={openMerge}
        onComplete={openComplete}
        onCancel={openCancel}
        onEdit={(task) => {
          setEditorTask(task)
          setEditorOpen(true)
        }}
      />
      <TaskMergeDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        task={mergeTask}
      />
      <TaskCompleteDialog
        open={completeOpen}
        onOpenChange={setCompleteOpen}
        task={completeTask}
      />
      {/* Rendered after the sheet, like the transcript viewer: both portal to
          body and the later mount stacks above, so a cancel / restart asked
          for from inside the drawer lands on top of it. */}
      <TaskCancelDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        task={cancelTask}
      />
      <TaskRestartDialog
        open={restartOpen}
        onOpenChange={setRestartOpen}
        task={restartTask}
        kind={restartKind}
      />
      {/* Rendered after the sheet so it stacks above it when opened from
          within (both portal to body; later mount wins). */}
      <TaskTranscriptDialog
        open={sessionOpen && sessionTask != null}
        onOpenChange={setSessionOpen}
        task={sessionTask}
      />
      <TaskSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        folderId={folderFilter}
      />

      {/* Drag preview. Portalled to the body because a fixed element is
          positioned against the nearest transformed ancestor otherwise, and
          the board sits inside several. */}
      {drag
        ? createPortal(
            <div
              ref={ghostRef}
              className="pointer-events-none fixed left-0 top-0 z-50 will-change-transform"
              style={{ width: drag.width }}
              aria-hidden="true"
            >
              <div
                className={cn(
                  "flex -rotate-1 flex-col gap-2 rounded-xl border bg-card p-3 shadow-lg",
                  dropArmed
                    ? "border-primary ring-2 ring-primary/25"
                    : "border-foreground/15"
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 break-words text-[0.8125rem] font-medium leading-snug">
                    {drag.task.title}
                  </span>
                  <StatusChip task={drag.task} />
                </div>
                {dropArmed ? (
                  <span className="inline-flex items-center gap-1 text-[0.6875rem] font-medium text-primary">
                    <Play className="size-3" aria-hidden="true" />
                    {t("dropToStart")}
                  </span>
                ) : null}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
