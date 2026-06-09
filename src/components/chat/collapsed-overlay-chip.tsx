"use client"

/**
 * Collapsed chip for the top-right conversation overlays (the plan panel and
 * the sub-agent panel).
 *
 * Rests as a circular icon button — minimal, so it doesn't crowd the message
 * area. The summary is `display:none` at rest, so the button is exactly the
 * 32px icon cap (a true circle, with no way for text to leak); on hover or
 * keyboard focus it switches to `flex` and reveals the full pill (summary +
 * chevron). Clicking it expands the owning overlay into its card. Shared so
 * both chips stay pixel identical.
 *
 * `summary` is the visible text AND the button's accessible name (`aria-label`),
 * so what a screen reader / voice-control user gets matches what a sighted user
 * reads on hover (WCAG 2.5.3); `aria-expanded` conveys the collapsed disclosure
 * state. The button carries no layout border (focus shows as a `ring`), so its
 * resting width stays exactly equal to its height.
 */

import type { ReactNode } from "react"
import { ChevronUpIcon } from "lucide-react"

import { cn } from "@/lib/utils"

interface CollapsedOverlayChipProps {
  /** Leading icon, shown alone when resting. Pass it sized (e.g. `size-4`). */
  icon: ReactNode
  /** Summary text revealed on hover/focus, e.g. "子智能体 3" / "计划 2/5". Also
   *  the button's accessible name. */
  summary: string
  /** Expands the owning overlay into its full card. */
  onClick: () => void
}

export function CollapsedOverlayChip({
  icon,
  summary,
  onClick,
}: CollapsedOverlayChipProps) {
  return (
    <div className="pointer-events-none flex">
      <button
        type="button"
        aria-label={summary}
        aria-expanded={false}
        onClick={onClick}
        className={cn(
          "group/chip pointer-events-auto flex h-8 items-center rounded-full",
          "bg-secondary/70 text-secondary-foreground shadow-md transition-colors hover:bg-secondary",
          "cursor-pointer outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        )}
      >
        {/* Fixed square icon cap — the whole resting chip is just this circle. */}
        <span className="grid size-8 shrink-0 place-items-center">{icon}</span>
        {/* Summary: hidden at rest (no width), revealed on hover/focus. */}
        <span className="hidden items-center gap-1 whitespace-nowrap pr-3 text-sm font-medium group-hover/chip:flex group-focus-visible/chip:flex">
          {summary}
          <ChevronUpIcon className="size-4 shrink-0 text-muted-foreground" />
        </span>
      </button>
    </div>
  )
}
