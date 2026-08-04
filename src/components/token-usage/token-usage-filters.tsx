"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, ChevronDown, X } from "lucide-react"
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
  /** Rendered dimmed after the label — a folder path, a token total, … */
  hint?: string
}

const TRIGGER_CLASS = cn(
  "h-8 max-w-[15rem] gap-1.5 rounded-full border-transparent bg-muted/70 px-3",
  "text-[0.8125rem] font-medium shadow-none hover:bg-muted"
)

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
  const summary =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
        : t("nSelected", { count: selected.length })

  const toggle = (value: string) => {
    onChange(
      selectedSet.has(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value]
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={cn(
            TRIGGER_CLASS,
            selected.length > 0 &&
              "bg-primary/10 text-primary hover:bg-primary/15"
          )}
          aria-label={label}
        >
          {Icon ? <Icon className="size-3.5 shrink-0 opacity-70" /> : null}
          <span className="truncate">{summary}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 rounded-xl p-1.5">
        <div className="flex items-center gap-1 px-1 pb-1.5">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-7 rounded-lg text-xs"
          />
          {selected.length > 0 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0 rounded-lg"
              aria-label={allLabel}
              onClick={() => onChange([])}
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
        <ScrollArea className="max-h-64">
          <div className="space-y-0.5 pr-1">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                {emptyLabel}
              </p>
            ) : (
              filtered.map((o) => {
                const active = selectedSet.has(o.value)
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => toggle(o.value)}
                    aria-pressed={active}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs outline-none",
                      "hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                    )}
                  >
                    <Check
                      className={cn(
                        "size-3.5 shrink-0",
                        active ? "opacity-100 text-primary" : "opacity-0"
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.hint ? (
                      <span className="shrink-0 truncate text-[0.625rem] text-muted-foreground">
                        {o.hint}
                      </span>
                    ) : null}
                  </button>
                )
              })
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}

/** A segmented pill group — used for the range presets and bucket width. */
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
