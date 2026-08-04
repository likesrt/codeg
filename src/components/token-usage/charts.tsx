"use client"

import { useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { useElementWidth } from "@/hooks/use-element-width"
import { formatTokenCount } from "@/lib/token-format"
import { formatTokensPrecise } from "@/lib/token-usage"

/**
 * Hand-rolled SVG charts for the token dashboard.
 *
 * No charting dependency: every mark here is a rect or a path over data the
 * backend already shaped, and rolling them by hand keeps the marks on the
 * project's own geometry (thin bars, 4px rounded data-ends, a 2px surface gap
 * between stacked segments) instead of a library's defaults.
 *
 * Colour comes from the `.tu-viz` scope in globals.css — a CVD-validated
 * categorical palette for identity, a single-hue ramp for magnitude. Slots are
 * assigned by fixed index and never cycled: past the eighth series the caller
 * folds the tail into one "other" slice (see `foldBreakdown`).
 */

/** Categorical slots, in the validated order. Index 8 is reserved for "other",
 *  which is deliberately neutral so a fold never impersonates a real series. */
export const SERIES_VARS = [
  "var(--tu-s1)",
  "var(--tu-s2)",
  "var(--tu-s3)",
  "var(--tu-s4)",
  "var(--tu-s5)",
  "var(--tu-s6)",
  "var(--tu-s7)",
  "var(--tu-s8)",
] as const

export const OTHER_VAR = "var(--muted-foreground)"

export function seriesColor(index: number): string {
  return SERIES_VARS[index] ?? OTHER_VAR
}

// ─── Trend ──────────────────────────────────────────────────────────────

export interface TrendDatum {
  key: string
  label: string
  value: number
  /** Extra lines for the tooltip, already formatted and translated. */
  detail: { label: string; value: string }[]
}

const TREND_HEIGHT = 216
const TREND_PAD_TOP = 12
const TREND_PAD_BOTTOM = 22
const GRID_LINES = 4

/**
 * Bucketed spend over time — one bar per bucket, one measure, one axis.
 *
 * Bars (not a line) because the buckets are discrete accumulations, and because
 * a range with quiet days should read as gaps rather than as a line
 * interpolating through zero.
 */
export function TrendChart({
  data,
  label,
  emptyLabel,
  className,
}: {
  data: TrendDatum[]
  /** Accessible name for the plot — what the chart shows, not what it says
   *  when it is empty. */
  label: string
  emptyLabel: string
  className?: string
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)

  const max = useMemo(
    () => data.reduce((m, d) => Math.max(m, d.value), 0),
    [data]
  )
  const plotHeight = TREND_HEIGHT - TREND_PAD_TOP - TREND_PAD_BOTTOM

  if (data.length === 0) {
    return (
      <div
        className={cn(
          "flex h-[216px] items-center justify-center text-sm text-muted-foreground",
          className
        )}
      >
        {emptyLabel}
      </div>
    )
  }

  // Bars keep a 2px surface gap from each other; below ~3px of drawable width
  // the gap would eat the bar, so it collapses first.
  const slot = width > 0 ? width / data.length : 0
  const gap = slot > 5 ? 2 : 0
  const barWidth = Math.max(1, slot - gap)
  const radius = Math.min(4, barWidth / 2)

  const hovered = hover !== null ? data[hover] : null

  return (
    <div ref={ref} className={cn("relative w-full", className)}>
      {width > 0 && (
        <svg
          width={width}
          height={TREND_HEIGHT}
          role="img"
          aria-label={label}
          className="block overflow-visible"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            const x = e.clientX - rect.left
            const index = Math.floor(x / slot)
            setHover(index >= 0 && index < data.length ? index : null)
          }}
        >
          {/* Recessive grid: four lines, no axis rules, no tick marks. */}
          {Array.from({ length: GRID_LINES + 1 }, (_, i) => {
            const y = TREND_PAD_TOP + (plotHeight * i) / GRID_LINES
            return (
              <line
                key={i}
                x1={0}
                x2={width}
                y1={y}
                y2={y}
                className="stroke-border"
                strokeWidth={1}
                opacity={i === GRID_LINES ? 0.8 : 0.35}
              />
            )
          })}

          {data.map((d, i) => {
            const height =
              max > 0 && d.value > 0
                ? Math.max(2, (d.value / max) * plotHeight)
                : 0
            const x = i * slot + gap / 2
            const y = TREND_PAD_TOP + plotHeight - height
            return (
              <g key={d.key}>
                {/* Full-height hit target: a 2px-tall bar is impossible to
                    hover, so the pointer lands on the column, not the mark. */}
                <rect
                  x={i * slot}
                  y={TREND_PAD_TOP}
                  width={slot}
                  height={plotHeight}
                  fill="transparent"
                />
                {height > 0 && (
                  <rect
                    x={x}
                    y={y}
                    width={barWidth}
                    height={height}
                    rx={radius}
                    ry={radius}
                    fill="var(--tu-s1)"
                    opacity={hover === null || hover === i ? 1 : 0.45}
                  />
                )}
              </g>
            )
          })}

          {/* Endpoint labels only — a tick under every bucket would collide at
              any realistic bucket count, and the tooltip carries the rest. */}
          <text
            x={0}
            y={TREND_HEIGHT - 6}
            className="fill-muted-foreground text-[0.6875rem]"
          >
            {data[0]?.label}
          </text>
          {data.length > 1 && (
            <text
              x={width}
              y={TREND_HEIGHT - 6}
              textAnchor="end"
              className="fill-muted-foreground text-[0.6875rem]"
            >
              {data[data.length - 1]?.label}
            </text>
          )}
          <text
            x={0}
            y={TREND_PAD_TOP - 3}
            className="fill-muted-foreground text-[0.6875rem]"
          >
            {formatTokenCount(max)}
          </text>
        </svg>
      )}

      {hover !== null && hovered && (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-[9rem] rounded-lg border border-border bg-popover px-2.5 py-2 text-xs shadow-md"
          style={{
            // Clamp so the card never hangs off either edge.
            left: Math.min(
              Math.max(0, (hover + 0.5) * slot - 72),
              Math.max(0, width - 150)
            ),
          }}
        >
          <div className="font-medium text-popover-foreground">
            {hovered.label}
          </div>
          <div className="mt-1 font-mono text-[0.8125rem] text-popover-foreground">
            {formatTokensPrecise(hovered.value)}
          </div>
          {hovered.detail.map((d) => (
            <div
              key={d.label}
              className="mt-0.5 flex justify-between gap-3 text-muted-foreground"
            >
              <span>{d.label}</span>
              <span className="font-mono">{d.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Composition ────────────────────────────────────────────────────────

export interface CompositionSegment {
  key: string
  label: string
  value: number
}

/**
 * One 100%-stacked bar for the input/output/cache split, with a fully labeled
 * legend underneath.
 *
 * The legend is not optional decoration: on a light surface two of these slots
 * sit below 3:1 against white, so identity has to be carried by visible text —
 * which the legend rows do, value and share included.
 */
export function CompositionBar({
  segments,
  className,
}: {
  segments: CompositionSegment[]
  className?: string
}) {
  const total = segments.reduce((s, seg) => s + seg.value, 0)
  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full">
        {total > 0 ? (
          segments.map((seg, i) =>
            seg.value > 0 ? (
              <div
                key={seg.key}
                className="h-full first:rounded-l-full last:rounded-r-full"
                style={{
                  width: `${(seg.value / total) * 100}%`,
                  backgroundColor: seriesColor(i),
                }}
              />
            ) : null
          )
        ) : (
          <div className="h-full w-full rounded-full bg-muted" />
        )}
      </div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
        {segments.map((seg, i) => (
          <li key={seg.key} className="flex items-center gap-1.5 text-xs">
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-[2px]"
              style={{ backgroundColor: seriesColor(i) }}
            />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {seg.label}
            </span>
            <span className="shrink-0 font-mono tabular-nums">
              {formatTokenCount(seg.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ─── Ranked bars ────────────────────────────────────────────────────────

export interface RankedDatum {
  key: string
  label: string
  value: number
  /** Rendered right of the value — e.g. a session count. */
  hint?: string
  /** Overrides the slot colour (used for the folded "other" row). */
  color?: string
}

/**
 * A ranked horizontal-bar list — the form for "which of these is biggest".
 *
 * Every row is directly labeled with its name and value, so the bars are a
 * magnitude cue rather than the only way to read the chart.
 */
export function RankedBars({
  data,
  emptyLabel,
  onSelect,
  className,
}: {
  data: RankedDatum[]
  emptyLabel: string
  onSelect?: (key: string) => void
  className?: string
}) {
  const max = data.reduce((m, d) => Math.max(m, d.value), 0)
  if (data.length === 0) {
    return (
      <p
        className={cn(
          "py-6 text-center text-sm text-muted-foreground",
          className
        )}
      >
        {emptyLabel}
      </p>
    )
  }
  return (
    <ul className={cn("space-y-2.5", className)}>
      {data.map((d, i) => {
        const pct = max > 0 ? (d.value / max) * 100 : 0
        const row = (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: d.color ?? seriesColor(i) }}
                />
                <span className="truncate text-[0.8125rem]">{d.label}</span>
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                {d.hint ? `${d.hint} · ` : ""}
                {formatTokenCount(d.value)}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(pct, d.value > 0 ? 1.5 : 0)}%`,
                  backgroundColor: d.color ?? seriesColor(i),
                }}
              />
            </div>
          </>
        )
        return (
          <li key={d.key}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(d.key)}
                className="w-full rounded-md px-1 py-0.5 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
              >
                {row}
              </button>
            ) : (
              <div className="px-1 py-0.5">{row}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ─── Heatmap ────────────────────────────────────────────────────────────

const RAMP_VARS = [
  "var(--tu-seq-1)",
  "var(--tu-seq-2)",
  "var(--tu-seq-3)",
  "var(--tu-seq-4)",
  "var(--tu-seq-5)",
  "var(--tu-seq-6)",
  "var(--tu-seq-7)",
] as const

/**
 * Map a value to a ramp step.
 *
 * Square-root rather than linear: one all-nighter would otherwise flatten every
 * other cell to the palest step, hiding the weekly rhythm the chart exists to
 * show. Zero is not on the ramp at all — it returns `null` so the caller can
 * draw an explicit empty cell.
 */
export function rampStep(value: number, max: number): number | null {
  if (value <= 0 || max <= 0) return null
  const normalized = Math.sqrt(value / max)
  const step = Math.ceil(normalized * RAMP_VARS.length)
  return Math.min(RAMP_VARS.length, Math.max(1, step)) - 1
}

export function ActivityHeatmap({
  matrix,
  max,
  weekdayLabels,
  formatTitle,
  legendLess,
  legendMore,
  className,
}: {
  matrix: number[][]
  max: number
  weekdayLabels: string[]
  formatTitle: (weekday: number, hour: number, value: number) => string
  legendLess: string
  legendMore: string
  className?: string
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex gap-1.5">
        <div className="flex shrink-0 flex-col justify-around py-[1px] text-[0.625rem] leading-none text-muted-foreground">
          {weekdayLabels.map((label, i) => (
            // Every other row labeled: seven stacked 10px labels in ~120px of
            // height collide, and the alternating rail still reads as a week.
            <span key={i} className="h-[calc(100%/7)] pr-0.5">
              {i % 2 === 0 ? label : ""}
            </span>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          {matrix.map((row, weekday) => (
            <div
              key={weekday}
              className="grid gap-[2px]"
              // 24 columns is past Tailwind's named grid-cols scale; an inline
              // template keeps it exact instead of relying on a JIT-generated
              // utility that a purge could miss.
              style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}
            >
              {row.map((value, hour) => {
                const step = rampStep(value, max)
                return (
                  <div
                    key={hour}
                    title={formatTitle(weekday, hour, value)}
                    className={cn(
                      "aspect-square w-full rounded-[2px]",
                      step === null &&
                        "bg-muted/40 ring-1 ring-inset ring-border/50"
                    )}
                    style={
                      step === null
                        ? undefined
                        : { backgroundColor: RAMP_VARS[step] }
                    }
                  />
                )
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5 text-[0.625rem] text-muted-foreground">
        <span>{legendLess}</span>
        <span className="size-2.5 rounded-[2px] bg-muted/40 ring-1 ring-inset ring-border/50" />
        {RAMP_VARS.map((v) => (
          <span
            key={v}
            className="size-2.5 rounded-[2px]"
            style={{ backgroundColor: v }}
          />
        ))}
        <span>{legendMore}</span>
      </div>
    </div>
  )
}

// ─── Sparkline ──────────────────────────────────────────────────────────

/**
 * The compact trend used on the share card. An area (not bars) because at
 * poster scale the shape is what carries, and a filled silhouette survives the
 * downscale that thin bars would not.
 */
export function Sparkline({
  values,
  width,
  height,
  color = "var(--tu-s1)",
  className,
}: {
  values: number[]
  width: number
  height: number
  color?: string
  className?: string
}) {
  if (values.length === 0 || width <= 0 || height <= 0) return null
  const max = Math.max(...values, 1)
  const step = values.length > 1 ? width / (values.length - 1) : width
  const points = values.map((v, i) => {
    const x = values.length > 1 ? i * step : width / 2
    // 1px inset top and bottom so the stroke is never clipped by the viewBox.
    const y = height - 1 - (v / max) * (height - 2)
    return [x, y] as const
  })
  const line = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(" ")
  const area = `${line} L${width},${height} L0,${height} Z`

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden="true"
    >
      <path d={area} fill={color} opacity={0.18} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
