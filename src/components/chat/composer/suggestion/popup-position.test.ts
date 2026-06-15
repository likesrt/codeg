import { describe, expect, it } from "vitest"

import { placeMentionPopup } from "./popup-position"

const SIZE = { width: 320, height: 288 }
const VIEWPORT = { width: 1280, height: 800 }
// Defaults the helper uses: margin=8, gap=4.

describe("placeMentionPopup", () => {
  it("anchors the left edge at the caret when there is room", () => {
    const pos = placeMentionPopup(
      { left: 100, top: 600, bottom: 620 },
      SIZE,
      VIEWPORT
    )
    expect(pos.left).toBe(100)
  })

  it("clamps the left edge so the panel stays inside the right margin", () => {
    // caret far right: 1200 + 320 would overflow the 1280 viewport.
    const pos = placeMentionPopup(
      { left: 1200, top: 600, bottom: 620 },
      SIZE,
      VIEWPORT
    )
    // max left = 1280 - 320 - 8 = 952
    expect(pos.left).toBe(952)
  })

  it("clamps the left edge to the left margin for a negative caret x", () => {
    const pos = placeMentionPopup(
      { left: -50, top: 600, bottom: 620 },
      SIZE,
      VIEWPORT
    )
    expect(pos.left).toBe(8)
  })

  it("pins to the left margin when the panel is wider than the viewport", () => {
    const pos = placeMentionPopup(
      { left: 100, top: 300, bottom: 320 },
      { width: 600, height: 200 },
      { width: 400, height: 800 }
    )
    expect(pos.left).toBe(8)
  })

  it("places the panel above the caret when there is room (composer at bottom)", () => {
    const pos = placeMentionPopup(
      { left: 100, top: 600, bottom: 620 },
      SIZE,
      VIEWPORT
    )
    expect(pos.placement).toBe("above")
    // top = caret.top - gap - height = 600 - 4 - 288 = 308
    expect(pos.top).toBe(308)
  })

  it("flips below the caret when there is not enough room above", () => {
    // caret near the top: only 50px above, panel needs 288+4.
    const pos = placeMentionPopup(
      { left: 100, top: 50, bottom: 70 },
      SIZE,
      VIEWPORT
    )
    expect(pos.placement).toBe("below")
    // top = caret.bottom + gap = 70 + 4 = 74
    expect(pos.top).toBe(74)
  })

  it("falls back to the side with more room when neither fully fits", () => {
    // Short viewport: nothing fits. caret.top=120 (roomAbove≈112),
    // caret.bottom=140 in a 300-tall viewport (roomBelow≈152) → below wins.
    const pos = placeMentionPopup({ left: 100, top: 120, bottom: 140 }, SIZE, {
      width: 1280,
      height: 300,
    })
    expect(pos.placement).toBe("below")
    // top clamps so the panel doesn't leave the viewport bottom:
    // min(140+4, 300-288-8)=min(144,4)=4 → max(8,4)=8
    expect(pos.top).toBe(8)
  })

  it("prefers above when both sides are equally cramped", () => {
    // Symmetric: caret centered in a viewport too short for either side.
    const pos = placeMentionPopup({ left: 100, top: 150, bottom: 150 }, SIZE, {
      width: 1280,
      height: 300,
    })
    expect(pos.placement).toBe("above")
  })

  it("pins to the top-left corner when the caret rect is null", () => {
    const pos = placeMentionPopup(null, SIZE, VIEWPORT)
    expect(pos).toEqual({ left: 8, top: 8, placement: "below" })
  })

  it("respects custom margin and gap options", () => {
    const pos = placeMentionPopup(
      { left: 100, top: 600, bottom: 620 },
      SIZE,
      VIEWPORT,
      { margin: 16, gap: 10 }
    )
    // above: top = 600 - 10 - 288 = 302
    expect(pos.top).toBe(302)
    expect(pos.left).toBe(100)
  })
})
