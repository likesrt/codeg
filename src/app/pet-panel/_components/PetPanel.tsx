"use client"

import { useEffect, useMemo } from "react"
import { useTranslations } from "next-intl"
import { Inbox, X } from "lucide-react"
import { closePetPanel } from "@/lib/pet/api"
import { usePetSessions } from "../../pet/_hooks/usePetSessions"
import { sessionSortRank } from "@/lib/pet/session-display"
import { SessionRow } from "./SessionRow"

export function PetPanel() {
  const t = useTranslations("Pet")
  const { sessions } = usePetSessions()

  const sorted = useMemo(
    () => [...sessions].sort((a, b) => sessionSortRank(a) - sessionSortRank(b)),
    [sessions]
  )

  // Transparent OS window so the rounded card + shadow show through. Mirrors
  // the sprite window's body treatment; restored on unmount.
  useEffect(() => {
    const prevBody = document.body.style.background
    const prevHtml = document.documentElement.style.background
    document.body.style.background = "transparent"
    document.documentElement.style.background = "transparent"
    return () => {
      document.body.style.background = prevBody
      document.documentElement.style.background = prevHtml
    }
  }, [])

  // Esc dismisses, matching the click-away (blur) behaviour.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void closePetPanel().catch(() => {})
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden p-2"
      style={{ background: "transparent" }}
    >
      <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-border/70 bg-card/95 shadow-lg backdrop-blur">
        <header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
          <div className="text-sm font-semibold">
            {t("panel.title")}
            {sorted.length > 0 ? (
              <span className="ml-1 font-normal text-muted-foreground">
                ({sorted.length})
              </span>
            ) : null}
          </div>
          <button
            type="button"
            aria-label={t("menu.close")}
            onClick={() => void closePetPanel().catch(() => {})}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        {sorted.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <Inbox className="h-8 w-8 text-muted-foreground/50" />
            <div className="text-sm font-medium">{t("panel.empty")}</div>
            <div className="text-xs text-muted-foreground">
              {t("panel.emptyHint")}
            </div>
          </div>
        ) : (
          <ul className="flex-1 overflow-y-auto py-1">
            {sorted.map((session) => (
              <SessionRow key={session.connectionId} session={session} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
