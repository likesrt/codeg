"use client"

/**
 * Ask-user-question settings panel — a single feature kill switch persisted as
 * `question.enabled` on the Rust side.
 *
 * When enabled (the default), `codeg-mcp` exposes the `ask_user_question` tool so
 * an agent can block on a multiple-choice question rendered as an interactive
 * card above the conversation input box. Mounted under `/settings/general` next
 * to the live-feedback section, because it's a global feature, not per-agent.
 *
 * Unlike live-feedback, no module-cached frontend flag is needed: the card is
 * driven entirely by the backend `question_request` event, which only fires when
 * the tool was injected (i.e. the setting was on at launch).
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { HelpCircle, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  type QuestionSettings,
  getQuestionSettings,
  setQuestionSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"

export function AskQuestionSettingsSection() {
  const t = useTranslations("AskQuestionSettings")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getQuestionSettings()
      .then((s) => {
        if (cancelled) return
        setEnabled(s.enabled)
        setLoadError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(toErrorMessage(err))
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(async () => {
    const payload: QuestionSettings = { enabled }
    setSaving(true)
    try {
      const applied = await setQuestionSettings(payload)
      setEnabled(applied.enabled)
      toast.success(t("saved"))
    } catch (err: unknown) {
      toast.error(t("saveFailed"), { description: toErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }, [enabled, t])

  return (
    <section className="rounded-xl border bg-card p-4 space-y-4">
      <div className="flex items-center gap-2">
        <HelpCircle className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">{t("title")}</h2>
      </div>
      <p className="text-xs text-muted-foreground leading-5">
        {t("description")}
      </p>

      {loadError && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t("loadFailed", { detail: loadError })}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <label htmlFor="question-enabled" className="text-sm font-medium">
            {t("enable")}
          </label>
          <p className="text-xs text-muted-foreground">{t("enableHint")}</p>
        </div>
        <Switch
          id="question-enabled"
          checked={enabled}
          onCheckedChange={setEnabled}
          disabled={loading}
          className="shrink-0"
        />
      </div>

      <div className="flex justify-end pt-2">
        <Button onClick={save} disabled={loading || saving} size="sm">
          {saving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("saving")}
            </>
          ) : (
            t("save")
          )}
        </Button>
      </div>
    </section>
  )
}
