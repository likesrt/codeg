/** A caret bounding rect in viewport coordinates (the subset we need). */
export interface CaretRect {
  left: number
  top: number
  bottom: number
}

export interface PopupSize {
  width: number
  height: number
}

export interface Viewport {
  width: number
  height: number
}

export type PopupPlacement = "above" | "below"

export interface PopupPosition {
  /** Viewport x for the panel's left edge. */
  left: number
  /** Viewport y for the panel's top edge. */
  top: number
  /** Which side of the caret the panel landed on. */
  placement: PopupPlacement
}

export interface PlaceMentionPopupOptions {
  /** Padding kept between the panel and each viewport edge. Default 8. */
  margin?: number
  /** Gap between the caret and the panel's near edge. Default 4. */
  gap?: number
}

const DEFAULT_MARGIN = 8
const DEFAULT_GAP = 4

function clamp(value: number, min: number, max: number): number {
  // A degenerate band (panel larger than the space between the margins) makes
  // max < min; pin to min (the leading margin) rather than returning NaN-ish
  // ordering. The panel then overflows the far edge but scrolls internally.
  if (max < min) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * Compute a viewport-clamped position for the caret-anchored `@` mention popup.
 *
 * Pure (no DOM access) so it is unit-testable; the component measures the panel
 * and the viewport, then calls this.
 *
 * - **Horizontal**: the panel's left edge follows the caret but is clamped so
 *   the whole panel stays within `margin` of both viewport edges.
 * - **Vertical**: the panel prefers to sit *above* the caret (the composer
 *   usually hugs the screen bottom). It flips *below* when there isn't room
 *   above, and falls back to whichever side has more room when neither fully
 *   fits — always clamped so the panel never leaves the viewport.
 * - **No caret** (rare IME states where `clientRect` is null): pin to the
 *   top-left corner, still clamped.
 */
export function placeMentionPopup(
  caret: CaretRect | null,
  size: PopupSize,
  viewport: Viewport,
  options: PlaceMentionPopupOptions = {}
): PopupPosition {
  const margin = options.margin ?? DEFAULT_MARGIN
  const gap = options.gap ?? DEFAULT_GAP

  if (!caret) {
    return { left: margin, top: margin, placement: "below" }
  }

  const left = clamp(caret.left, margin, viewport.width - size.width - margin)

  const roomAbove = caret.top - margin
  const roomBelow = viewport.height - caret.bottom - margin
  const needed = size.height + gap

  let placement: PopupPlacement
  if (roomAbove >= needed) placement = "above"
  else if (roomBelow >= needed) placement = "below"
  // Neither side fully fits: take the side with more room.
  else placement = roomAbove >= roomBelow ? "above" : "below"

  const rawTop =
    placement === "above" ? caret.top - gap - size.height : caret.bottom + gap
  // Final clamp so even the "more room" fallback can't leave the viewport.
  const top = clamp(rawTop, margin, viewport.height - size.height - margin)

  return { left, top, placement }
}
