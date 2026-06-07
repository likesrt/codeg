"use client"

import { useTranslations } from "next-intl"
import { AlertTriangle, Clock } from "lucide-react"
import { usePetSessions } from "../_hooks/usePetSessions"
import { pickPetBadge } from "@/lib/pet/session-display"

/**
 * Ambient status badge overlaid on the sprite's top-right corner — the codeg
 * analogue of Codex's pet "thought bubble". Always-visible signal so the user
 * knows the agent state without opening the panel:
 *
 *   • running → blue pill with the count of in-flight sessions
 *   • waiting → amber clock (a session is blocked on a permission)
 *   • error   → red warning
 *
 * Precedence mirrors the backend's ambient `compute_pet_state`
 * (error > waiting > running). Self-contained: it owns its `pet://sessions`
 * subscription so a session-list change re-renders only the badge, never the
 * animating sprite. `pointer-events-none` keeps taps/drags passing through to
 * the window.
 */
export function PetBadge() {
  const t = useTranslations("Pet")
  const badge = pickPetBadge(usePetSessions())

  if (!badge) return null
  const { kind, count } = badge

  const label = t(`badge.${kind}`, { count })
  // Running always shows the number; icon-led states show the count only when
  // more than one so a single waiting/errored session stays icon-clean.
  const showCount = kind === "running" || count > 1

  return (
    <div
      role="status"
      aria-label={label}
      title={label}
      className={[
        "pointer-events-none absolute right-0.5 top-0.5 z-10 flex h-5 min-w-[1.25rem]",
        "items-center justify-center gap-0.5 rounded-full px-1 text-[10px] font-semibold",
        "leading-none text-white shadow-md ring-2 ring-white/70",
        kind === "error"
          ? "bg-red-500"
          : kind === "waiting"
            ? "bg-amber-500"
            : "bg-blue-500",
      ].join(" ")}
    >
      {kind === "error" ? (
        <AlertTriangle className="h-3 w-3" aria-hidden />
      ) : kind === "waiting" ? (
        <Clock className="h-3 w-3" aria-hidden />
      ) : null}
      {showCount ? <span>{count}</span> : null}
    </div>
  )
}
