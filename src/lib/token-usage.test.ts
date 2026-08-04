import { describe, expect, it } from "vitest"

import {
  addLocalDays,
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
  resolveRange,
  shareCardFilename,
  startOfLocalDay,
  suggestBucket,
} from "./token-usage"
import type {
  TokenUsageBreakdownItem,
  TokenUsageHeatCell,
  TokenUsagePoint,
  TokenUsageReport,
  TokenUsageTotals,
} from "./types"

function totals(over: Partial<TokenUsageTotals> = {}): TokenUsageTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
    turn_count: 0,
    conversation_count: 0,
    duration_ms: 0,
    active_days: 0,
    ...over,
  }
}

function item(
  key: string,
  total: number,
  over: Partial<TokenUsageBreakdownItem> = {}
): TokenUsageBreakdownItem {
  return {
    key,
    label: key,
    input_tokens: total,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: total,
    turn_count: 1,
    conversation_count: 1,
    ...over,
  }
}

function cell(
  weekday: number,
  hour: number,
  total: number
): TokenUsageHeatCell {
  return { weekday, hour, total_tokens: total, turn_count: 1 }
}

function report(over: Partial<TokenUsageReport> = {}): TokenUsageReport {
  return {
    range_start: null,
    range_end: null,
    bucket: "day",
    totals: totals(),
    previous_totals: null,
    series: [],
    by_folder: [],
    by_agent: [],
    by_model: [],
    heatmap: [],
    top_conversations: [],
    streak: { longest_days: 0, current_days: 0, current_ends_on: null },
    first_activity_at: null,
    last_activity_at: null,
    truncated: false,
    ...over,
  }
}

function point(key: string, total: number): TokenUsagePoint {
  return {
    bucket_key: key,
    start: `${key}T00:00:00.000Z`,
    end: `${key}T00:00:00.000Z`,
    input_tokens: total,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: total,
    turn_count: 1,
    conversation_count: 1,
  }
}

/** Local-midnight ISO for a `YYYY-MM-DD`, so assertions don't hard-code the
 *  runner's timezone. */
function localMidnightIso(y: number, m: number, d: number): string {
  return new Date(y, m - 1, d).toISOString()
}

describe("resolveRange", () => {
  const now = new Date(2026, 7, 3, 14, 30) // 2026-08-03 local

  it("makes the last-7-days preset seven whole local days ending with today", () => {
    const range = resolveRange("7d", now)
    expect(range.start).toBe(localMidnightIso(2026, 7, 28))
    expect(range.end).toBe(localMidnightIso(2026, 8, 4))
  })

  it("anchors 'this month' to the first of the month", () => {
    const range = resolveRange("thisMonth", now)
    expect(range.start).toBe(localMidnightIso(2026, 8, 1))
    expect(range.end).toBe(localMidnightIso(2026, 8, 4))
  })

  it("anchors 'this year' to January 1", () => {
    expect(resolveRange("thisYear", now).start).toBe(
      localMidnightIso(2026, 1, 1)
    )
  })

  it("leaves 'all' unbounded so the backend clamps to the data", () => {
    expect(resolveRange("all", now)).toEqual({ start: null, end: null })
  })

  it("widens a custom range's end to the following midnight, so one day is a whole day", () => {
    const day = new Date(2026, 6, 10)
    const range = resolveRange("custom", now, { from: day, to: day })
    expect(range.start).toBe(localMidnightIso(2026, 7, 10))
    expect(range.end).toBe(localMidnightIso(2026, 7, 11))
  })

  it("keeps a half-filled custom range open on the missing side", () => {
    const range = resolveRange("custom", now, {
      from: new Date(2026, 6, 10),
      to: null,
    })
    expect(range.start).toBe(localMidnightIso(2026, 7, 10))
    expect(range.end).toBeNull()
  })

  it("falls back to unbounded when a custom range has neither end", () => {
    expect(resolveRange("custom", now, { from: null, to: null })).toEqual({
      start: null,
      end: null,
    })
  })
})

describe("startOfLocalDay / addLocalDays", () => {
  it("truncates to local midnight", () => {
    const d = startOfLocalDay(new Date(2026, 7, 3, 23, 59, 59))
    expect(d.getHours()).toBe(0)
    expect(d.getDate()).toBe(3)
  })

  it("crosses a month boundary", () => {
    const d = addLocalDays(new Date(2026, 7, 31), 1)
    expect(d.getMonth()).toBe(8)
    expect(d.getDate()).toBe(1)
  })
})

describe("suggestBucket", () => {
  it("uses days for short ranges, weeks for a year, months beyond", () => {
    const from = (days: number) =>
      suggestBucket({
        start: "2026-01-01T00:00:00.000Z",
        end: new Date(
          Date.parse("2026-01-01T00:00:00.000Z") + days * 86_400_000
        ).toISOString(),
      })
    expect(from(30)).toBe("day")
    expect(from(92)).toBe("day")
    expect(from(200)).toBe("week")
    expect(from(1000)).toBe("month")
  })

  it("defaults an unbounded range to weeks", () => {
    expect(suggestBucket({ start: null, end: null })).toBe("week")
  })
})

describe("localTzOffsetMinutes", () => {
  it("flips the sign of getTimezoneOffset (minutes east of UTC)", () => {
    const now = new Date()
    expect(localTzOffsetMinutes(now)).toBe(-now.getTimezoneOffset())
  })
})

describe("computeDelta", () => {
  it("reports a ratio against the previous window", () => {
    expect(computeDelta(150, 100)).toEqual({ ratio: 0.5, direction: "up" })
    expect(computeDelta(50, 100)).toEqual({ ratio: -0.5, direction: "down" })
  })

  it("has no ratio when the previous window was empty — 'new', not +100%", () => {
    expect(computeDelta(100, 0)).toEqual({ ratio: null, direction: "up" })
    expect(computeDelta(0, 0)).toEqual({ ratio: null, direction: "flat" })
  })

  it("treats a sub-half-percent move as flat", () => {
    expect(computeDelta(1002, 1000).direction).toBe("flat")
  })
})

describe("foldBreakdown", () => {
  it("passes short lists through untouched", () => {
    const items = [item("a", 3), item("b", 2)]
    expect(foldBreakdown(items, 7)).toEqual({ shown: items, other: null })
  })

  it("folds the tail into one 'other' slice that sums the rest", () => {
    const items = [item("a", 10), item("b", 5), item("c", 3), item("d", 2)]
    const { shown, other } = foldBreakdown(items, 2)
    expect(shown.map((i) => i.key)).toEqual(["a", "b"])
    expect(other?.key).toBe("__other__")
    expect(other?.total_tokens).toBe(5)
    expect(other?.conversation_count).toBe(2)
  })

  it("drops an all-zero tail rather than drawing an empty slice", () => {
    const items = [item("a", 10), item("b", 0), item("c", 0)]
    expect(foldBreakdown(items, 1).other).toBeNull()
  })
})

describe("buildHeatMatrix", () => {
  it("expands sparse cells into a dense 7 × 24 grid", () => {
    const { cells, max } = buildHeatMatrix([cell(0, 9, 100), cell(6, 23, 40)])
    expect(cells).toHaveLength(7)
    expect(cells[0]).toHaveLength(24)
    expect(cells[0][9]).toBe(100)
    expect(cells[6][23]).toBe(40)
    expect(cells[3][3]).toBe(0)
    expect(max).toBe(100)
  })

  it("ignores out-of-range coordinates instead of throwing", () => {
    const { cells, max } = buildHeatMatrix([cell(9, 9, 100), cell(0, 30, 50)])
    expect(max).toBe(0)
    expect(cells.flat().every((v) => v === 0)).toBe(true)
  })

  it("sums duplicate cells for the same slot", () => {
    const { cells } = buildHeatMatrix([cell(1, 1, 10), cell(1, 1, 5)])
    expect(cells[1][1]).toBe(15)
  })
})

describe("cacheHitRate", () => {
  it("measures cache reads against everything that entered as context", () => {
    const rate = cacheHitRate(
      totals({
        input_tokens: 100,
        cache_creation_tokens: 100,
        cache_read_tokens: 800,
        output_tokens: 9_999,
      })
    )
    // Output is excluded: it was never cacheable.
    expect(rate).toBe(0.8)
  })

  it("returns null when nothing entered as context", () => {
    expect(cacheHitRate(totals({ output_tokens: 500 }))).toBeNull()
  })
})

describe("averages", () => {
  it("divide by their own denominator and never by zero", () => {
    expect(
      averagePerConversation(
        totals({ total_tokens: 100, conversation_count: 4 })
      )
    ).toBe(25)
    expect(averagePerConversation(totals({ total_tokens: 100 }))).toBe(0)
    expect(
      averagePerActiveDay(totals({ total_tokens: 90, active_days: 3 }))
    ).toBe(30)
    expect(averagePerActiveDay(totals({ total_tokens: 90 }))).toBe(0)
  })
})

describe("peakPoint / peakHour", () => {
  it("finds the busiest bucket, skipping empty ones", () => {
    const series = [
      point("2026-08-01", 0),
      point("2026-08-02", 50),
      point("2026-08-03", 20),
    ]
    expect(peakPoint(series)?.bucket_key).toBe("2026-08-02")
    expect(peakPoint([point("2026-08-01", 0)])).toBeNull()
    expect(peakPoint([])).toBeNull()
  })

  it("sums each hour across weekdays before picking the peak", () => {
    // Hour 3 wins on the sum (30 + 30) even though hour 10 has the single
    // biggest cell.
    const cells = [cell(0, 3, 30), cell(1, 3, 30), cell(2, 10, 50)]
    expect(peakHour(cells)).toBe(3)
    expect(peakHour([])).toBeNull()
  })
})

describe("deriveArchetype", () => {
  it("picks the night owl when most tokens burn after dark", () => {
    const a = deriveArchetype(
      report({
        heatmap: [cell(0, 23, 60), cell(1, 14, 40)],
        totals: totals({ total_tokens: 100 }),
      })
    )
    expect(a.id).toBe("nightOwl")
    expect(a.values.percent).toBe(60)
  })

  it("prefers a time-of-day pattern over a cache-ratio one when both hold", () => {
    const a = deriveArchetype(
      report({
        heatmap: [cell(0, 23, 60), cell(1, 14, 40)],
        totals: totals({
          total_tokens: 100,
          input_tokens: 10,
          cache_read_tokens: 90,
        }),
      })
    )
    expect(a.id).toBe("nightOwl")
  })

  it("falls back to cache mastery when the clock says nothing", () => {
    const a = deriveArchetype(
      report({
        heatmap: [cell(0, 14, 100)],
        totals: totals({
          total_tokens: 100,
          input_tokens: 10,
          cache_read_tokens: 90,
        }),
      })
    )
    expect(a.id).toBe("cacheMaster")
    expect(a.values.percent).toBe(90)
  })

  it("needs a second project before calling it laser focus", () => {
    const single = deriveArchetype(
      report({
        heatmap: [cell(0, 14, 100)],
        totals: totals({ total_tokens: 100, conversation_count: 100 }),
        by_folder: [item("1", 100)],
      })
    )
    expect(single.id).toBe("steady")

    const many = deriveArchetype(
      report({
        heatmap: [cell(0, 14, 100)],
        totals: totals({ total_tokens: 100, conversation_count: 100 }),
        by_folder: [item("1", 80), item("2", 20)],
      })
    )
    expect(many.id).toBe("laserFocus")
  })

  it("always lands on a real archetype for an empty report", () => {
    const a = deriveArchetype(report())
    expect(a.id).toBe("steady")
    expect(a.values.days).toBe(0)
  })
})

describe("formatTokensPrecise", () => {
  it("keeps two decimals in the millions so a headline is not lossy", () => {
    expect(formatTokensPrecise(1_284_000)).toBe("1.28M")
    expect(formatTokensPrecise(2_500_000_000)).toBe("2.50B")
    expect(formatTokensPrecise(45_600)).toBe("45.6K")
  })

  it("prints small counts in full", () => {
    expect(formatTokensPrecise(0)).toBe("0")
    expect(formatTokensPrecise(842)).toBe("842")
  })

  it("does not print a negative or non-finite count", () => {
    expect(formatTokensPrecise(-5)).toBe("0")
    expect(formatTokensPrecise(Number.NaN)).toBe("0")
  })
})

describe("formatDuration", () => {
  it("drops to the two largest useful units", () => {
    expect(formatDuration(0)).toBe("0s")
    expect(formatDuration(12_000)).toBe("12s")
    expect(formatDuration(185_000)).toBe("3m 05s")
    expect(formatDuration(5_040_000)).toBe("1h 24m")
  })
})

describe("shareCardFilename", () => {
  it("names the file after the range it depicts", () => {
    const name = shareCardFilename(
      { start: "2026-07-01T00:00:00.000Z", end: "2026-08-01T00:00:00.000Z" },
      new Date("2026-08-03T12:00:00.000Z")
    )
    // The end date shown is the last day actually counted, not the exclusive
    // bound.
    expect(name).toBe("codeg-tokens-2026-07-01_2026-07-31-2026-08-03.png")
  })

  it("says all-time for an unbounded range", () => {
    const name = shareCardFilename(
      { start: null, end: null },
      new Date("2026-08-03T12:00:00.000Z")
    )
    expect(name).toBe("codeg-tokens-all-time-2026-08-03.png")
  })
})
