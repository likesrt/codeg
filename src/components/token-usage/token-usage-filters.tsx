"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, ChevronDown, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

export interface FilterOption {
  value: string
  label: string
  /** Rendered as a dimmed second line — a folder path, a token total, … */
  hint?: string
}

const TRIGGER_CLASS = cn(
  "h-8 max-w-[15rem] gap-1.5 rounded-full border-transparent bg-muted/70 px-3",
  "text-[0.8125rem] font-medium shadow-none hover:bg-muted"
)
const TRIGGER_ACTIVE_CLASS = "bg-primary/10 text-primary hover:bg-primary/15"

/** One selectable row. Selection is a trailing check so the text column stays
 *  flush-left — no phantom indent on unchecked rows. */
function OptionRow({
  option,
  active,
  onClick,
}: {
  option: FilterOption
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left outline-none",
        "hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
        active && "bg-accent/40"
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs leading-snug">
          {option.label}
        </span>
        {option.hint ? (
          // Paths render LTR even in RTL locales, and the full value survives
          // truncation via the tooltip.
          <span
            dir="ltr"
            title={option.hint}
            className="block truncate text-start font-mono text-[0.625rem] leading-snug text-muted-foreground"
          >
            {option.hint}
          </span>
        ) : null}
      </span>
      <Check
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 text-primary",
          active ? "opacity-100" : "opacity-0"
        )}
      />
    </button>
  )
}

/**
 * One dimension of the dashboard filter: a pill that opens a searchable
 * checklist.
 *
 * `selected` is empty ⇔ "all". That collapse is deliberate — the backend reads
 * an absent list as no constraint, so "nothing checked" and "everything
 * checked" describe the same query and the control only ever has to represent
 * one of them.
 */
export function MultiSelectFilter({
  label,
  allLabel,
  options,
  selected,
  onChange,
  searchPlaceholder,
  emptyLabel,
  icon: Icon,
}: {
  /** The dimension's name — also the summary prefix when several are picked. */
  label: string
  allLabel: string
  options: FilterOption[]
  selected: string[]
  onChange: (next: string[]) => void
  searchPlaceholder: string
  emptyLabel: string
  icon?: React.ComponentType<{ className?: string }>
}) {
  const [query, setQuery] = useState("")
  const t = useTranslations("TokenUsage")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        (o.hint?.toLowerCase().includes(q) ?? false)
    )
  }, [options, query])

  const selectedSet = useMemo(() => new Set(selected), [selected])
  // "Folders · 3" rather than an anonymous count — the pill still says which
  // dimension it is filtering once the chosen labels no longer fit.
  const summary =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${label} · ${selected.length}`

  const toggle = (value: string) => {
    onChange(
      selectedSet.has(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value]
    )
  }

  return (
    <Popover onOpenChange={(open) => !open && setQuery("")}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={cn(
            TRIGGER_CLASS,
            selected.length > 0 && TRIGGER_ACTIVE_CLASS
          )}
          aria-label={label}
        >
          {Icon ? <Icon className="size-3.5 shrink-0 opacity-70" /> : null}
          <span className="truncate">{summary}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        // gap-0: the shared PopoverContent is a `flex flex-col gap-4` — left
        // alone it injects 16px seams between the search header, the list and
        // the footer.
        className="w-72 gap-0 overflow-hidden rounded-xl p-0"
      >
        {/* Command-palette style search: a bare input under the header rule —
            the boxed Input with its focus ring is far too loud in a popover
            this small. */}
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="h-9 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={t("clearFilter")}
              className="shrink-0 rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <ScrollArea className="max-h-72">
          <div className="space-y-px p-1.5">
            {filtered.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                {emptyLabel}
              </p>
            ) : (
              filtered.map((o) => (
                <OptionRow
                  key={o.value}
                  option={o}
                  active={selectedSet.has(o.value)}
                  onClick={() => toggle(o.value)}
                />
              ))
            )}
          </div>
        </ScrollArea>
        {selected.length > 0 && (
          <div className="border-t border-border p-1.5">
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full rounded-lg px-2.5 py-1.5 text-center text-xs text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("clearFilter")}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * A single-choice pill — holds the range presets that did not earn a
 * permanent segment (this month, this year, all time, custom). Shows the
 * chosen option's label and the active tint while one of its options is
 * selected; a plain "More" otherwise.
 */
export function SingleSelectFilter({
  placeholder,
  ariaLabel,
  options,
  value,
  onChange,
}: {
  placeholder: string
  ariaLabel: string
  options: FilterOption[]
  /** `null` when none of this pill's options is the active one. */
  value: string | null
  onChange: (next: string) => void
}) {
  const [open, setOpen] = useState(false)
  const current = value ? options.find((o) => o.value === value) : undefined

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={cn(TRIGGER_CLASS, current && TRIGGER_ACTIVE_CLASS)}
          aria-label={ariaLabel}
        >
          <span className="truncate">{current?.label ?? placeholder}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-44 gap-px rounded-xl p-1.5">
        {options.map((o) => (
          <OptionRow
            key={o.value}
            option={o}
            active={o.value === value}
            onClick={() => {
              onChange(o.value)
              setOpen(false)
            }}
          />
        ))}
      </PopoverContent>
    </Popover>
  )
}

/** A segmented pill group — used for the hot range presets and bucket width. */
export function SegmentedFilter<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
  ariaLabel: string
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex h-8 items-center gap-0.5 rounded-full bg-muted/70 p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            "h-7 rounded-full px-2.5 text-[0.8125rem] font-medium outline-none transition-colors",
            "focus-visible:ring-2 focus-visible:ring-ring",
            value === o.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Two native date inputs for the custom range.
 *
 * `type="date"` rather than a bespoke calendar: it is keyboard-accessible and
 * locale-formatted for free, and the value is already the `YYYY-MM-DD` local
 * day the range math wants. `max` on the start input and `min` on the end input
 * make an inverted range unrepresentable instead of merely invalid.
 */
export function CustomRangeFields({
  from,
  to,
  onChange,
}: {
  from: string
  to: string
  onChange: (next: { from: string; to: string }) => void
}) {
  const t = useTranslations("TokenUsage")
  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="date"
        value={from}
        max={to || undefined}
        aria-label={t("customFrom")}
        onChange={(e) => onChange({ from: e.target.value, to })}
        className="h-8 w-[9.5rem] rounded-full border-transparent bg-muted/70 px-3 text-[0.8125rem]"
      />
      <span className="text-xs text-muted-foreground">–</span>
      <Input
        type="date"
        value={to}
        min={from || undefined}
        aria-label={t("customTo")}
        onChange={(e) => onChange({ from, to: e.target.value })}
        className="h-8 w-[9.5rem] rounded-full border-transparent bg-muted/70 px-3 text-[0.8125rem]"
      />
    </div>
  )
}
