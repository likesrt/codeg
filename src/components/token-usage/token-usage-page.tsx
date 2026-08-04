"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react"
import { useTranslations, useLocale } from "next-intl"
import { toast } from "sonner"
import {
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  ChartNoAxesColumn,
  Cpu,
  Folder,
  RefreshCw,
  RotateCcw,
  Share2,
  Sparkles,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  tokenUsageFacets,
  tokenUsageReport,
  tokenUsageStatus,
  tokenUsageSync,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { getAgentLabel } from "@/lib/custom-agents"
import { subscribe } from "@/lib/platform"
import { formatTokenCount } from "@/lib/token-format"
import {
  averagePerActiveDay,
  averagePerConversation,
  buildHeatMatrix,
  cacheHitRate,
  computeDelta,
  deriveArchetype,
  foldBreakdown,
  formatDuration,
  formatTokensPrecise,
  localTzOffsetMinutes,
  peakHour,
  peakPoint,
  RANGE_PRESETS,
  resolveRange,
  shareCardFilename,
  suggestBucket,
  type TokenUsageRangePreset,
} from "@/lib/token-usage"
import { cn } from "@/lib/utils"
import type {
  AgentType,
  TokenUsageBucket,
  TokenUsageFacets,
  TokenUsageReport,
  TokenUsageSyncProgress,
  TokenUsageSyncStatus,
} from "@/lib/types"
import {
  ActivityHeatmap,
  CompositionBar,
  RankedBars,
  TrendChart,
  seriesColor,
  OTHER_VAR,
  type RankedDatum,
} from "./charts"
import {
  CustomRangeFields,
  MultiSelectFilter,
  SegmentedFilter,
} from "./token-usage-filters"
import {
  ARCHETYPE_DESC_KEYS,
  ARCHETYPE_EMOJI,
  ARCHETYPE_LABEL_KEYS,
  CARD_HEIGHT,
  CARD_WIDTH,
  ShareCard,
} from "./share-card"

const SYNC_PROGRESS_EVENT = "token-usage-sync://progress"
/** Fired once per batch import — see `CONVERSATIONS_BULK_CHANGED_EVENT` in
 *  `web/event_bridge.rs`. */
const CONVERSATIONS_BULK_CHANGED_EVENT = "conversations://bulk-changed"

/** How much the on-screen preview shrinks the full-size card. */
const CARD_PREVIEW_SCALE = 0.5

/** Whether this runtime can put an image on the clipboard. WKWebView and older
 *  browsers expose `navigator.clipboard` without `write`/`ClipboardItem`, so
 *  feature-detect both rather than assuming. */
function canCopyImages(): boolean {
  return (
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  )
}

/** Slices shown before the tail is folded into "Other" — the categorical
 *  palette has eight validated slots and the folded row takes one. */
const BREAKDOWN_LIMIT = 7

const RANGE_LABEL_KEYS = {
  "7d": "range7d",
  "30d": "range30d",
  "90d": "range90d",
  thisMonth: "rangeThisMonth",
  thisYear: "rangeThisYear",
  all: "rangeAll",
  custom: "rangeCustom",
} as const satisfies Record<TokenUsageRangePreset, string>

const BUCKET_LABEL_KEYS = {
  day: "bucketDay",
  week: "bucketWeek",
  month: "bucketMonth",
} as const satisfies Record<TokenUsageBucket, string>

const WEEKDAY_KEYS = [
  "weekMon",
  "weekTue",
  "weekWed",
  "weekThu",
  "weekFri",
  "weekSat",
  "weekSun",
] as const

/** Page title in the window-chrome strip — same metrics as the Tasks and
 *  Automations routes so all three open with one header rhythm. */
export function TokenUsagePageTitle() {
  const t = useTranslations("TokenUsage")
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 pl-4">
      <h1 className="flex items-center gap-1.5 text-[0.8125rem] font-semibold leading-none">
        <ChartNoAxesColumn
          className="size-4 text-muted-foreground"
          aria-hidden="true"
        />
        {t("title")}
      </h1>
    </div>
  )
}

function StatTile({
  label,
  value,
  hint,
  delta,
  deltaLabel,
}: {
  label: string
  value: string
  hint?: string
  delta?: { ratio: number | null; direction: "up" | "down" | "flat" } | null
  deltaLabel?: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-xl font-semibold tabular-nums leading-tight">
        {value}
      </div>
      {delta && delta.direction !== "flat" ? (
        <div className="mt-1 flex items-center gap-1 text-[0.6875rem]">
          {delta.direction === "up" ? (
            <ArrowUpRight
              className="size-3 text-[var(--tu-s3)]"
              aria-hidden="true"
            />
          ) : (
            <ArrowDownRight
              className="size-3 text-[var(--tu-s2)]"
              aria-hidden="true"
            />
          )}
          <span className="font-mono tabular-nums text-muted-foreground">
            {delta.ratio === null
              ? deltaLabel
              : `${delta.ratio > 0 ? "+" : ""}${Math.round(delta.ratio * 100)}%`}
          </span>
        </div>
      ) : hint ? (
        <div className="mt-1 truncate text-[0.6875rem] text-muted-foreground">
          {hint}
        </div>
      ) : null}
    </div>
  )
}

function Panel({
  title,
  hint,
  icon: Icon,
  children,
  className,
}: {
  title: string
  hint?: string
  icon?: ComponentType<{ className?: string }>
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={cn("rounded-xl border border-border bg-card p-4", className)}
    >
      <header className="mb-3">
        <h2 className="flex items-center gap-1.5 text-[0.8125rem] font-semibold">
          {Icon ? (
            <Icon
              className="size-3.5 text-muted-foreground"
              aria-hidden="true"
            />
          ) : null}
          {title}
        </h2>
        {hint ? (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </header>
      {children}
    </section>
  )
}

/**
 * The Token Usage route.
 *
 * Data flows one way: filter state → one `token_usage_report` call → one
 * render. Every aggregate on screen (buckets, breakdowns, heatmap, streak,
 * top sessions) comes from that single response, so nothing on the page can
 * disagree with anything else on it.
 */
export function TokenUsagePage() {
  const t = useTranslations("TokenUsage")
  const locale = useLocale()

  const [preset, setPreset] = useState<TokenUsageRangePreset>("30d")
  const [custom, setCustom] = useState({ from: "", to: "" })
  const [bucket, setBucket] = useState<TokenUsageBucket>("day")
  const [bucketTouched, setBucketTouched] = useState(false)
  const [folderIds, setFolderIds] = useState<string[]>([])
  const [agentTypes, setAgentTypes] = useState<string[]>([])
  const [models, setModels] = useState<string[]>([])

  const [facets, setFacets] = useState<TokenUsageFacets | null>(null)
  const [status, setStatus] = useState<TokenUsageSyncStatus | null>(null)
  const [report, setReport] = useState<TokenUsageReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<TokenUsageSyncProgress | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  const cardRef = useRef<HTMLDivElement | null>(null)
  const reqRef = useRef(0)
  // Frozen at mount so range presets stay anchored to when the page was
  // opened; reading the clock during render is impure. Same idiom as the
  // Automations page.
  const [now] = useState(() => new Date())

  const range = useMemo(
    () =>
      resolveRange(preset, now, {
        from: custom.from ? new Date(`${custom.from}T00:00:00`) : null,
        to: custom.to ? new Date(`${custom.to}T00:00:00`) : null,
      }),
    [preset, now, custom]
  )

  // The bucket follows the range until the user picks one, after which their
  // choice sticks — derived, so there is no effect racing the fetch.
  const effectiveBucket = bucketTouched ? bucket : suggestBucket(range)

  const load = useCallback(async () => {
    const id = ++reqRef.current
    setError(null)
    try {
      const [next, nextFacets, nextStatus] = await Promise.all([
        tokenUsageReport({
          start: range.start,
          end: range.end,
          folderIds: folderIds.length ? folderIds.map(Number) : null,
          agentTypes: agentTypes.length ? agentTypes : null,
          models: models.length ? models : null,
          bucket: effectiveBucket,
          tzOffsetMinutes: localTzOffsetMinutes(now),
          comparePrevious: true,
        }),
        tokenUsageFacets(),
        tokenUsageStatus(),
      ])
      // Drop a response overtaken by a newer request, so fast filter clicks
      // can't land an older result last.
      if (id !== reqRef.current) return
      setReport(next)
      setFacets(nextFacets)
      setStatus(nextStatus)
    } catch (e) {
      if (id !== reqRef.current) return
      setError(toErrorMessage(e))
    } finally {
      if (id === reqRef.current) setLoading(false)
    }
  }, [range, folderIds, agentTypes, models, effectiveBucket, now])

  useEffect(() => {
    void load()
  }, [load])

  // Latest-ref so the event subscription below is set up once, not torn down
  // and re-established on every filter change (`load`'s identity tracks the
  // filters). Same idiom as tasks-view-context.
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  // Progress ticks are broadcast, so a sync started from another window (or
  // the web client) drives this progress bar too.
  useEffect(() => {
    let unsub: (() => void) | undefined
    let cancelled = false
    void subscribe<TokenUsageSyncProgress>(SYNC_PROGRESS_EVENT, (payload) => {
      setProgress(payload.result ? null : payload)
      if (payload.result) {
        setSyncing(false)
        void loadRef.current()
      }
    }).then((u) => {
      if (cancelled) u()
      else unsub = u
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  // An import is the main way new sessions appear while this page is open, and
  // it drops the usage stamp of everything it touched. Refetch so the stale
  // count updates in place instead of waiting for a remount.
  useEffect(() => {
    let unsub: (() => void) | undefined
    let cancelled = false
    void subscribe(CONVERSATIONS_BULK_CHANGED_EVENT, () => {
      void loadRef.current()
    }).then((u) => {
      if (cancelled) u()
      else unsub = u
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  const runSync = useCallback(
    async (mode: "incremental" | "full", opts?: { silent?: boolean }) => {
      setSyncing(true)
      setProgress(null)
      try {
        const result = await tokenUsageSync(mode)
        if (!opts?.silent)
          toast.success(t("syncDone", { synced: result.synced }))
        if (result.failed > 0) toast.warning(t("syncFailed"))
      } catch (e) {
        // A silent pass still surfaces failures — the user needs to know the
        // numbers on screen are incomplete, even if they never asked for the
        // refresh.
        toast.error(toErrorMessage(e))
      } finally {
        setSyncing(false)
        setProgress(null)
        await load()
      }
    },
    [load, t]
  )

  // Catch the facts up once per page mount when they are behind the
  // conversation list — the common case right after importing local sessions,
  // where making the user find a button before seeing any numbers would be a
  // needless step. Silent: it reports failures but not routine success.
  //
  // The ref latches before the call, so the `status` refresh that a sync
  // triggers cannot start a second one.
  const autoSyncedRef = useRef(false)
  useEffect(() => {
    if (autoSyncedRef.current || !status) return
    autoSyncedRef.current = true
    if (status.running || status.stale_conversations === 0) return
    void runSync("incremental", { silent: true })
  }, [status, runSync])

  const folderOptions = useMemo(
    () =>
      (facets?.folders ?? []).map((f) => ({
        value: String(f.folder_id),
        label: f.label,
        hint: f.path,
      })),
    [facets]
  )
  const agentOptions = useMemo(
    () =>
      (facets?.agents ?? []).map((a) => ({
        value: a,
        label: getAgentLabel(a as AgentType),
      })),
    [facets]
  )
  const modelOptions = useMemo(
    () => (facets?.models ?? []).map((m) => ({ value: m, label: m })),
    [facets]
  )

  const hasFilters =
    folderIds.length > 0 || agentTypes.length > 0 || models.length > 0
  const resetFilters = () => {
    setFolderIds([])
    setAgentTypes([])
    setModels([])
  }

  const totals = report?.totals
  const cache = totals ? cacheHitRate(totals) : null
  const heat = useMemo(
    () => buildHeatMatrix(report?.heatmap ?? []),
    [report?.heatmap]
  )
  const archetype = useMemo(
    () => (report ? deriveArchetype(report) : null),
    [report]
  )

  const weekdayLabels = WEEKDAY_KEYS.map((k) => t(k))

  const formatBucketLabel = useCallback(
    (bucketKey: string) => {
      // Month buckets carry `YYYY-MM`; day and week buckets carry the first
      // local day of the bucket.
      if (bucketKey.length === 7) {
        const [y, m] = bucketKey.split("-")
        return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(
          locale,
          {
            year: "numeric",
            month: "short",
          }
        )
      }
      const [y, m, d] = bucketKey.split("-")
      return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString(
        locale,
        { month: "short", day: "numeric" }
      )
    },
    [locale]
  )

  const trendData = useMemo(
    () =>
      (report?.series ?? []).map((p) => ({
        key: p.bucket_key,
        label: formatBucketLabel(p.bucket_key),
        value: p.total_tokens,
        detail: [
          {
            label: t("trendTurns"),
            value: p.turn_count.toLocaleString(locale),
          },
          {
            label: t("trendSessions"),
            value: p.conversation_count.toLocaleString(locale),
          },
        ],
      })),
    [report?.series, formatBucketLabel, t, locale]
  )

  const toRanked = useCallback(
    (
      items: TokenUsageReport["by_model"],
      label: (key: string, fallback: string) => string
    ): RankedDatum[] => {
      const { shown, other } = foldBreakdown(items, BREAKDOWN_LIMIT)
      const rows: RankedDatum[] = shown.map((it) => ({
        key: it.key,
        label: label(it.key, it.label),
        value: it.total_tokens,
        hint: t("sessionsCount", { count: it.conversation_count }),
      }))
      if (other) {
        rows.push({
          key: other.key,
          label: t("otherLabel"),
          value: other.total_tokens,
          hint: t("sessionsCount", { count: other.conversation_count }),
          color: OTHER_VAR,
        })
      }
      return rows
    },
    [t]
  )

  const exportCard = useCallback(
    async (action: "save" | "copy") => {
      const node = cardRef.current
      if (!node) return
      setExporting(true)
      try {
        const { toPng } = await import("html-to-image")
        const dataUrl = await toPng(node, {
          // Pinned to the card's own layout box. The preview wrapper scales it
          // with a CSS transform, and passing the size explicitly means the
          // export can never inherit that preview scale.
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          // 2× so the poster stays crisp when a chat app re-encodes it.
          pixelRatio: 2,
          backgroundColor: "#0b1220",
          cacheBust: true,
          style: { transform: "none", transformOrigin: "top left" },
        })
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1)
        if (action === "copy") {
          if (!canCopyImages()) {
            // Safari/WKWebView and older browsers have no image clipboard —
            // say so instead of throwing an opaque ReferenceError.
            toast.error(t("shareFailed"))
            return
          }
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
          await navigator.clipboard.write([
            new ClipboardItem({
              "image/png": new Blob([bytes as BlobPart], { type: "image/png" }),
            }),
          ])
          toast.success(t("shareCopied"))
        } else {
          const { downloadImage } = await import("@/lib/image-download")
          const saved = await downloadImage({
            data: base64,
            mime_type: "image/png",
            suggestedName: shareCardFilename(range, now),
          })
          if (saved) toast.success(t("shareSaved"))
        }
      } catch (e) {
        toast.error(`${t("shareFailed")}: ${toErrorMessage(e)}`)
      } finally {
        setExporting(false)
      }
    },
    [range, now, t]
  )

  const isEmpty =
    !loading &&
    report != null &&
    report.totals.total_tokens === 0 &&
    (status?.fact_rows ?? 0) === 0

  return (
    <TooltipProvider delayDuration={300}>
      <div className="tu-viz flex h-full min-h-0 flex-col">
        {/* ─── Toolbar ─── */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 pb-3">
          <SegmentedFilter
            ariaLabel={t("rangeLabel")}
            value={preset}
            onChange={(v) => setPreset(v)}
            options={[...RANGE_PRESETS, "custom" as const].map((p) => ({
              value: p,
              label: t(RANGE_LABEL_KEYS[p]),
            }))}
          />
          {preset === "custom" && (
            <CustomRangeFields
              from={custom.from}
              to={custom.to}
              onChange={setCustom}
            />
          )}
          <SegmentedFilter
            ariaLabel={t("bucketLabel")}
            value={effectiveBucket}
            onChange={(v) => {
              setBucket(v)
              setBucketTouched(true)
            }}
            options={(["day", "week", "month"] as const).map((b) => ({
              value: b,
              label: t(BUCKET_LABEL_KEYS[b]),
            }))}
          />

          <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

          <MultiSelectFilter
            icon={Folder}
            label={t("folderFilter")}
            allLabel={t("allFolders")}
            options={folderOptions}
            selected={folderIds}
            onChange={setFolderIds}
            searchPlaceholder={t("searchPlaceholder")}
            emptyLabel={t("noMatches")}
          />
          <MultiSelectFilter
            icon={Bot}
            label={t("agentFilter")}
            allLabel={t("allAgents")}
            options={agentOptions}
            selected={agentTypes}
            onChange={setAgentTypes}
            searchPlaceholder={t("searchPlaceholder")}
            emptyLabel={t("noMatches")}
          />
          <MultiSelectFilter
            icon={Cpu}
            label={t("modelFilter")}
            allLabel={t("allModels")}
            options={modelOptions}
            selected={models}
            onChange={setModels}
            searchPlaceholder={t("searchPlaceholder")}
            emptyLabel={t("noMatches")}
          />
          {hasFilters && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground"
              onClick={resetFilters}
            >
              <RotateCcw className="size-3.5" />
              {t("resetFilters")}
            </Button>
          )}

          <div className="ml-auto flex items-center gap-2">
            {status && status.stale_conversations > 0 && !syncing && (
              <span className="text-xs text-muted-foreground">
                {t("staleHint", { count: status.stale_conversations })}
              </span>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 rounded-full px-3 text-xs"
                  disabled={syncing}
                  onClick={() => void runSync("incremental")}
                >
                  <RefreshCw
                    className={cn("size-3.5", syncing && "animate-spin")}
                  />
                  {syncing ? t("syncing") : t("refresh")}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {status?.last_synced_at
                  ? t("lastSynced", {
                      time: new Date(status.last_synced_at).toLocaleString(
                        locale
                      ),
                    })
                  : t("lastSyncedNever")}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 rounded-full px-3 text-xs text-muted-foreground"
                  disabled={syncing}
                  onClick={() => void runSync("full")}
                >
                  {t("rebuild")}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-64">
                {t("rebuildHint")}
              </TooltipContent>
            </Tooltip>
            <Button
              type="button"
              size="sm"
              className="h-8 gap-1.5 rounded-full px-3 text-xs"
              disabled={!report || report.totals.total_tokens === 0}
              onClick={() => setShareOpen(true)}
            >
              <Share2 className="size-3.5" />
              {t("share")}
            </Button>
          </div>
        </div>

        {progress && progress.total > 0 && (
          <div className="shrink-0 space-y-1 border-b border-border px-4 py-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="truncate">
                {progress.current_title ?? t("syncing")}
              </span>
              <span className="ml-2 shrink-0 font-mono tabular-nums">
                {t("syncProgress", {
                  done: progress.done,
                  total: progress.total,
                })}
              </span>
            </div>
            <Progress value={(progress.done / progress.total) * 100} />
          </div>
        )}

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-4">
            {error && (
              <p className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {t("loadFailed")}: {error}
              </p>
            )}

            {report?.truncated && (
              <p className="rounded-xl border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
                {t("truncatedNotice")}
              </p>
            )}

            {isEmpty ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 py-20 text-center">
                <ChartNoAxesColumn
                  className="size-8 text-muted-foreground"
                  aria-hidden="true"
                />
                <h2 className="text-base font-semibold">{t("emptyTitle")}</h2>
                <p className="max-w-md text-sm text-muted-foreground">
                  {t("emptyHint")}
                </p>
                <Button
                  type="button"
                  className="mt-1 gap-1.5"
                  disabled={syncing}
                  onClick={() => void runSync("incremental")}
                >
                  <RefreshCw
                    className={cn("size-4", syncing && "animate-spin")}
                  />
                  {t("emptyAction")}
                </Button>
              </div>
            ) : (
              totals &&
              report && (
                <>
                  {/* Headline */}
                  {archetype && totals.total_tokens > 0 && (
                    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-gradient-to-r from-[var(--tu-s1)]/8 to-transparent px-4 py-3">
                      <span className="text-lg leading-none" aria-hidden="true">
                        {ARCHETYPE_EMOJI[archetype.id]}
                      </span>
                      <span className="text-sm font-semibold">
                        {t(ARCHETYPE_LABEL_KEYS[archetype.id])}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {t(ARCHETYPE_DESC_KEYS[archetype.id], archetype.values)}
                      </span>
                      <Sparkles
                        className="ml-auto size-4 text-[var(--tu-s1)]"
                        aria-hidden="true"
                      />
                    </div>
                  )}

                  {/* Stat tiles */}
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                    <StatTile
                      label={t("tileTotal")}
                      value={formatTokensPrecise(totals.total_tokens)}
                      delta={
                        report.previous_totals
                          ? computeDelta(
                              totals.total_tokens,
                              report.previous_totals.total_tokens
                            )
                          : null
                      }
                      deltaLabel={t("deltaNew")}
                    />
                    <StatTile
                      label={t("tileSessions")}
                      value={totals.conversation_count.toLocaleString(locale)}
                      delta={
                        report.previous_totals
                          ? computeDelta(
                              totals.conversation_count,
                              report.previous_totals.conversation_count
                            )
                          : null
                      }
                      deltaLabel={t("deltaNew")}
                    />
                    <StatTile
                      label={t("tileTurns")}
                      value={totals.turn_count.toLocaleString(locale)}
                      hint={`${t("avgPerSession")} ${formatTokenCount(
                        Math.round(averagePerConversation(totals))
                      )}`}
                    />
                    <StatTile
                      label={t("tileCacheRate")}
                      value={
                        cache === null ? "—" : `${Math.round(cache * 100)}%`
                      }
                      hint={`${t("cacheSavedTitle")} ${formatTokenCount(
                        totals.cache_read_tokens
                      )}`}
                    />
                    <StatTile
                      label={t("tileActiveDays")}
                      value={totals.active_days.toLocaleString(locale)}
                      hint={`${t("streakLongest")} ${report.streak.longest_days}`}
                    />
                    <StatTile
                      label={t("tileGenTime")}
                      value={formatDuration(totals.duration_ms)}
                      hint={`${t("avgPerActiveDay")} ${formatTokenCount(
                        Math.round(averagePerActiveDay(totals))
                      )}`}
                    />
                  </div>

                  <Panel title={t("trendTitle")} icon={ChartNoAxesColumn}>
                    <TrendChart
                      data={trendData}
                      label={t("trendTitle")}
                      emptyLabel={t("trendEmpty")}
                    />
                    {(() => {
                      const peak = peakPoint(report.series)
                      const hour = peakHour(report.heatmap)
                      if (!peak && hour === null) return null
                      return (
                        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                          {peak && (
                            <span>
                              {t("peakBucket", {
                                bucket: t(BUCKET_LABEL_KEYS[report.bucket]),
                              })}
                              :{" "}
                              <span className="font-mono tabular-nums text-foreground">
                                {formatBucketLabel(peak.bucket_key)} ·{" "}
                                {formatTokenCount(peak.total_tokens)}
                              </span>
                            </span>
                          )}
                          {hour !== null && (
                            <span>
                              {t("peakHour")}:{" "}
                              <span className="font-mono tabular-nums text-foreground">
                                {String(hour).padStart(2, "0")}:00
                              </span>
                            </span>
                          )}
                        </div>
                      )
                    })()}
                  </Panel>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <Panel
                      title={t("compositionTitle")}
                      hint={t("compositionHint")}
                    >
                      <CompositionBar
                        segments={[
                          {
                            key: "input",
                            label: t("inputTokens"),
                            value: totals.input_tokens,
                          },
                          {
                            key: "output",
                            label: t("outputTokens"),
                            value: totals.output_tokens,
                          },
                          {
                            key: "cacheWrite",
                            label: t("cacheWrite"),
                            value: totals.cache_creation_tokens,
                          },
                          {
                            key: "cacheRead",
                            label: t("cacheRead"),
                            value: totals.cache_read_tokens,
                          },
                        ]}
                      />
                    </Panel>

                    <Panel title={t("heatmapTitle")} hint={t("heatmapHint")}>
                      <ActivityHeatmap
                        matrix={heat.cells}
                        max={heat.max}
                        weekdayLabels={weekdayLabels}
                        legendLess={t("less")}
                        legendMore={t("more")}
                        formatTitle={(weekday, hour, value) =>
                          t("heatmapCell", {
                            weekday: weekdayLabels[weekday],
                            hour: String(hour).padStart(2, "0"),
                            value: formatTokenCount(value),
                          })
                        }
                      />
                    </Panel>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-3">
                    <Panel title={t("byFolderTitle")} icon={Folder}>
                      <RankedBars
                        data={toRanked(report.by_folder, (_, label) => label)}
                        emptyLabel={t("emptyBreakdown")}
                        onSelect={(key) =>
                          key !== "__other__" && setFolderIds([key])
                        }
                      />
                    </Panel>
                    <Panel title={t("byAgentTitle")} icon={Bot}>
                      <RankedBars
                        data={toRanked(report.by_agent, (key) =>
                          getAgentLabel(key as AgentType)
                        )}
                        emptyLabel={t("emptyBreakdown")}
                        onSelect={(key) =>
                          key !== "__other__" && setAgentTypes([key])
                        }
                      />
                    </Panel>
                    <Panel title={t("byModelTitle")} icon={Cpu}>
                      <RankedBars
                        data={toRanked(report.by_model, (key, label) =>
                          key === "__unknown__" ? t("unknownModel") : label
                        )}
                        emptyLabel={t("emptyBreakdown")}
                        onSelect={(key) =>
                          key !== "__other__" &&
                          key !== "__unknown__" &&
                          setModels([key])
                        }
                      />
                    </Panel>
                  </div>

                  <Panel title={t("topSessionsTitle")}>
                    {report.top_conversations.length === 0 ? (
                      <p className="py-6 text-center text-sm text-muted-foreground">
                        {t("topSessionsEmpty")}
                      </p>
                    ) : (
                      <ol className="divide-y divide-border">
                        {report.top_conversations.map((c, i) => (
                          <li
                            key={c.conversation_id}
                            className="flex items-center gap-3 py-2 first:pt-0 last:pb-0"
                          >
                            <span
                              aria-hidden="true"
                              className="size-2 shrink-0 rounded-[2px]"
                              style={{ backgroundColor: seriesColor(i) }}
                            />
                            <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
                              {c.title || t("untitledSession")}
                            </span>
                            <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:block sm:max-w-[10rem]">
                              {c.folder_label}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {getAgentLabel(c.agent_type as AgentType)}
                            </span>
                            <span className="shrink-0 font-mono text-xs tabular-nums">
                              {formatTokenCount(c.total_tokens)}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </Panel>
                </>
              )
            )}
          </div>
        </ScrollArea>

        {/* ─── Share ─── */}
        <Dialog open={shareOpen} onOpenChange={setShareOpen}>
          <DialogContent className="max-w-[26rem]">
            <DialogHeader>
              <DialogTitle>{t("shareDialogTitle")}</DialogTitle>
              <DialogDescription>{t("shareDialogHint")}</DialogDescription>
            </DialogHeader>
            {report && (
              // The card is always laid out at its natural size so the export
              // is identical everywhere; the wrapper only scales the on-screen
              // preview, and the outer box is sized to the scaled result so it
              // reserves exactly the space the preview occupies.
              <div
                className="mx-auto overflow-hidden rounded-xl border border-border"
                style={{
                  width: CARD_WIDTH * CARD_PREVIEW_SCALE,
                  height: CARD_HEIGHT * CARD_PREVIEW_SCALE,
                }}
              >
                <div
                  style={{
                    transform: `scale(${CARD_PREVIEW_SCALE})`,
                    transformOrigin: "top left",
                    width: CARD_WIDTH,
                    height: CARD_HEIGHT,
                  }}
                >
                  <ShareCard ref={cardRef} report={report} locale={locale} />
                </div>
              </div>
            )}
            <DialogFooter className="sm:justify-center">
              <Button
                type="button"
                variant="outline"
                disabled={exporting || !canCopyImages()}
                onClick={() => void exportCard("copy")}
              >
                {t("shareCopy")}
              </Button>
              <Button
                type="button"
                disabled={exporting}
                onClick={() => void exportCard("save")}
              >
                {exporting ? t("shareRendering") : t("shareSave")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  )
}
