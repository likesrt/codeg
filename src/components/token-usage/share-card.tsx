"use client"

import { forwardRef, useMemo } from "react"
import { useTranslations } from "next-intl"
import { getAgentLabel } from "@/lib/custom-agents"
import { formatTokenCount } from "@/lib/token-format"
import {
  cacheHitRate,
  deriveArchetype,
  formatDuration,
  formatTokensPrecise,
  type ArchetypeId,
} from "@/lib/token-usage"
import type { AgentType, TokenUsageReport } from "@/lib/types"
import { seriesColor, Sparkline } from "./charts"

/**
 * The shareable poster.
 *
 * ## Why it is styled the way it is
 *
 * This subtree is rasterized by `html-to-image`, which walks computed styles
 * and inlines them into an SVG `<foreignObject>`. Two consequences drive every
 * choice here:
 *
 *  1. **Fixed pixel geometry, not responsive units.** The card is always
 *     rendered at its natural 720 × 1040 size and scaled down for preview with
 *     a CSS transform on a wrapper, so the raster is identical regardless of
 *     the window it was exported from.
 *  2. **Literal colours, not CSS custom properties or Tailwind theme tokens.**
 *     Serialization resolves `var()` against the cloned node, and a token that
 *     only exists on an ancestor scope resolves to nothing — a card that looks
 *     right on screen would export with black-on-black text. Everything here is
 *     a hex literal, and the card is deliberately dark in both app themes so
 *     the exported image is one artifact, not two.
 */

/** The card's natural size. The page pins the export to exactly these numbers
 *  (and lays the preview out at them before scaling), so they are the one
 *  definition both sides read. */
export const CARD_WIDTH = 720
export const CARD_HEIGHT = 1040

const INK = {
  bg: "#0b1220",
  bgGlowA: "#1d4ed8",
  bgGlowB: "#0f766e",
  panel: "#111a2e",
  panelBorder: "#1f2c48",
  text: "#f8fafc",
  textMuted: "#94a3b8",
  textDim: "#64748b",
  accent: "#60a5fa",
} as const

export const ARCHETYPE_EMOJI: Record<ArchetypeId, string> = {
  nightOwl: "🌙",
  earlyBird: "🌅",
  weekendWarrior: "⚔️",
  cacheMaster: "⚡",
  marathoner: "🏃",
  polyglot: "🎛️",
  laserFocus: "🎯",
  deepDiver: "🤿",
  steady: "🧱",
}

/** Explicit key maps rather than a built `archetype${Id}` template string, so
 *  next-intl's key checking still catches a typo or a removed message. */
export const ARCHETYPE_LABEL_KEYS = {
  nightOwl: "archetypeNightOwl",
  earlyBird: "archetypeEarlyBird",
  weekendWarrior: "archetypeWeekendWarrior",
  cacheMaster: "archetypeCacheMaster",
  marathoner: "archetypeMarathoner",
  polyglot: "archetypePolyglot",
  laserFocus: "archetypeLaserFocus",
  deepDiver: "archetypeDeepDiver",
  steady: "archetypeSteady",
} as const satisfies Record<ArchetypeId, string>

export const ARCHETYPE_DESC_KEYS = {
  nightOwl: "archetypeNightOwlDesc",
  earlyBird: "archetypeEarlyBirdDesc",
  weekendWarrior: "archetypeWeekendWarriorDesc",
  cacheMaster: "archetypeCacheMasterDesc",
  marathoner: "archetypeMarathonerDesc",
  polyglot: "archetypePolyglotDesc",
  laserFocus: "archetypeLaserFocusDesc",
  deepDiver: "archetypeDeepDiverDesc",
  steady: "archetypeSteadyDesc",
} as const satisfies Record<ArchetypeId, string>

function formatDay(iso: string | null, locale: string): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub?: string
}) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        borderRadius: 16,
        padding: "16px 18px",
        backgroundColor: INK.panel,
        border: `1px solid ${INK.panelBorder}`,
      }}
    >
      <div
        style={{
          fontSize: 12,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: INK.textDim,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 26,
          fontWeight: 700,
          lineHeight: 1.1,
          color: INK.text,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      {sub ? (
        <div style={{ marginTop: 4, fontSize: 12, color: INK.textMuted }}>
          {sub}
        </div>
      ) : null}
    </div>
  )
}

function RankRow({
  rank,
  label,
  value,
  share,
  color,
}: {
  rank: number
  label: string
  value: string
  share: number
  color: string
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
          }}
        >
          <span
            style={{
              width: 18,
              fontSize: 12,
              color: INK.textDim,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {rank}
          </span>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 2,
              backgroundColor: color,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: 15,
              color: INK.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 200,
            }}
          >
            {label}
          </span>
        </div>
        <span
          style={{
            fontSize: 13,
            color: INK.textMuted,
            fontVariantNumeric: "tabular-nums",
            flexShrink: 0,
          }}
        >
          {value}
        </span>
      </div>
      <div
        style={{
          marginTop: 6,
          height: 4,
          borderRadius: 999,
          backgroundColor: "#1b2740",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.max(share * 100, 2)}%`,
            height: "100%",
            borderRadius: 999,
            backgroundColor: color,
          }}
        />
      </div>
    </div>
  )
}

export interface ShareCardProps {
  report: TokenUsageReport
  /** BCP-47 tag for date formatting — the app's active locale. */
  locale: string
}

/**
 * Rendered off-screen at full size and rasterized by the parent through the
 * forwarded ref.
 */
export const ShareCard = forwardRef<HTMLDivElement, ShareCardProps>(
  function ShareCard({ report, locale }, ref) {
    const t = useTranslations("TokenUsage")
    const { totals } = report

    const archetype = useMemo(() => deriveArchetype(report), [report])
    const cache = cacheHitRate(totals)
    const sparkValues = useMemo(
      () => report.series.map((p) => p.total_tokens),
      [report.series]
    )

    const rangeLabel =
      report.range_start && report.range_end
        ? `${formatDay(report.range_start, locale)} – ${formatDay(
            // `range_end` is exclusive; step back an instant so the printed
            // end date is the last day actually counted.
            new Date(new Date(report.range_end).getTime() - 1).toISOString(),
            locale
          )}`
        : t("cardRangeAll")

    const topModels = report.by_model.slice(0, 3)
    const topProjects = report.by_folder.slice(0, 3)
    const modelTotal = topModels.reduce((s, m) => s + m.total_tokens, 0)
    const projectTotal = topProjects.reduce((s, p) => s + p.total_tokens, 0)

    return (
      <div
        ref={ref}
        style={{
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          position: "relative",
          overflow: "hidden",
          backgroundColor: INK.bg,
          color: INK.text,
          fontFamily:
            '"Inter Variable", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          // The rasterizer walks the live tree, so the card must be laid out
          // (not `display: none`) even while it is parked off-screen.
          display: "flex",
          flexDirection: "column",
          padding: 44,
          boxSizing: "border-box",
        }}
      >
        {/* Two soft radial washes instead of a flat fill — enough depth to make
            the card feel designed, cheap enough to rasterize exactly. */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(760px 420px at 12% -6%, ${INK.bgGlowA}33, transparent 62%), radial-gradient(680px 460px at 105% 104%, ${INK.bgGlowB}2b, transparent 60%)`,
            pointerEvents: "none",
          }}
        />

        <div
          style={{
            position: "relative",
            flex: 1,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 16,
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  letterSpacing: "-0.02em",
                }}
              >
                {t("cardHeading")}
              </div>
              <div style={{ marginTop: 6, fontSize: 14, color: INK.textMuted }}>
                {rangeLabel}
              </div>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 14px",
                borderRadius: 999,
                backgroundColor: INK.panel,
                border: `1px solid ${INK.panelBorder}`,
                fontSize: 13,
                color: INK.textMuted,
              }}
            >
              <span style={{ fontSize: 15 }}>
                {ARCHETYPE_EMOJI[archetype.id]}
              </span>
              <span style={{ color: INK.text, fontWeight: 600 }}>
                {t(ARCHETYPE_LABEL_KEYS[archetype.id])}
              </span>
            </div>
          </div>

          {/* Hero number */}
          <div style={{ marginTop: 40 }}>
            <div
              style={{
                fontSize: 13,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: INK.textDim,
              }}
            >
              {t("cardTotalLabel")}
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 84,
                fontWeight: 800,
                letterSpacing: "-0.04em",
                lineHeight: 1,
                color: INK.text,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {formatTokensPrecise(totals.total_tokens)}
            </div>
            <div style={{ marginTop: 12, fontSize: 15, color: INK.accent }}>
              {t(ARCHETYPE_DESC_KEYS[archetype.id], archetype.values)}
            </div>
          </div>

          {/* Trend silhouette */}
          <div style={{ marginTop: 24, height: 84 }}>
            {sparkValues.length > 1 ? (
              <Sparkline
                values={sparkValues}
                width={CARD_WIDTH - 88}
                height={84}
                color={INK.accent}
              />
            ) : null}
          </div>

          {/* Stats */}
          <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
            <Stat
              label={t("tileSessions")}
              value={totals.conversation_count.toLocaleString(locale)}
            />
            <Stat
              label={t("tileTurns")}
              value={totals.turn_count.toLocaleString(locale)}
            />
            <Stat
              label={t("tileActiveDays")}
              value={totals.active_days.toLocaleString(locale)}
              sub={
                report.streak.longest_days > 1
                  ? `${t("streakLongest")} ${report.streak.longest_days}`
                  : undefined
              }
            />
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
            <Stat
              label={t("tileCacheRate")}
              value={cache === null ? "—" : `${Math.round(cache * 100)}%`}
              sub={`${t("cacheSavedTitle")} ${formatTokenCount(totals.cache_read_tokens)}`}
            />
            <Stat
              label={t("tileGenTime")}
              value={formatDuration(totals.duration_ms)}
            />
          </div>

          {/* Rankings */}
          <div style={{ display: "flex", gap: 28, marginTop: 28 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  color: INK.textDim,
                  marginBottom: 12,
                }}
              >
                {t("cardTopModels")}
              </div>
              {topModels.map((m, i) => (
                <RankRow
                  key={m.key}
                  rank={i + 1}
                  label={m.key === "__unknown__" ? t("unknownModel") : m.label}
                  value={formatTokenCount(m.total_tokens)}
                  share={modelTotal > 0 ? m.total_tokens / modelTotal : 0}
                  color={seriesColorHex(i)}
                />
              ))}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  color: INK.textDim,
                  marginBottom: 12,
                }}
              >
                {t("cardTopProjects")}
              </div>
              {topProjects.map((p, i) => (
                <RankRow
                  key={p.key}
                  rank={i + 1}
                  label={p.label}
                  value={formatTokenCount(p.total_tokens)}
                  share={projectTotal > 0 ? p.total_tokens / projectTotal : 0}
                  color={seriesColorHex(i)}
                />
              ))}
            </div>
          </div>

          {/* Footer */}
          <div
            style={{
              marginTop: "auto",
              paddingTop: 20,
              borderTop: `1px solid ${INK.panelBorder}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 0,
              }}
            >
              {report.by_agent.slice(0, 4).map((a, i) => (
                <span
                  key={a.key}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 10px",
                    borderRadius: 999,
                    backgroundColor: INK.panel,
                    border: `1px solid ${INK.panelBorder}`,
                    fontSize: 12,
                    color: INK.textMuted,
                    whiteSpace: "nowrap",
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      backgroundColor: seriesColorHex(i),
                    }}
                  />
                  {getAgentLabel(a.key as AgentType)}
                </span>
              ))}
            </div>
            <span
              style={{ fontSize: 13, color: INK.textDim, whiteSpace: "nowrap" }}
            >
              {t("cardFooter")}
            </span>
          </div>
        </div>
      </div>
    )
  }
)

/**
 * Dark-mode hexes of the categorical slots.
 *
 * The card can't read `var(--tu-s*)` — the rasterizer resolves custom
 * properties against the cloned subtree, where the `.tu-viz` scope no longer
 * applies. The card is always dark, so it pins the dark column of the same
 * validated palette rather than defining a second one.
 */
function seriesColorHex(index: number): string {
  const DARK_SLOTS = ["#3987e5", "#d95926", "#199e70", "#c98500"]
  return DARK_SLOTS[index] ?? "#64748b"
}

// Re-exported so the page can colour its own legend from the same source when
// it renders the live (non-exported) preview.
export { seriesColor }
