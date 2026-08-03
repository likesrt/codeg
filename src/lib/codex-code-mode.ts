/**
 * Codex "code mode" script card.
 *
 * Newer codex wraps every tool call in a JS script and persists the whole
 * script as ONE rollout record. The history parser
 * (`src-tauri/src/parsers/codex_code_mode.rs`) recovers the inner
 * `tools.<name>(…)` calls and re-emits them as the tool calls codex wrote
 * before code mode, so the existing cards keep working.
 *
 * When a script cannot be decomposed (variable destructuring, a command built
 * in a loop, template interpolation) the parser emits this synthetic tool
 * instead of guessing — its input carries the raw script for a JS code block.
 */
export const CODEX_SCRIPT_TOOL_NAME = "codex_script"

export interface CodexScriptCard {
  /** Raw JS source codex executed. */
  source: string
  /** Best-effort title (the first command the parser could read). */
  title: string | null
  /** Number of `tools.*` call sites detected in the script. */
  callCount: number
}

export function parseCodexScriptCard(
  input: string | null | undefined
): CodexScriptCard | null {
  if (!input) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null

  const record = parsed as Record<string, unknown>
  const source = record.source
  if (typeof source !== "string") return null

  const title = typeof record.title === "string" ? record.title : null
  const callCount =
    typeof record.call_count === "number" && Number.isFinite(record.call_count)
      ? record.call_count
      : 0

  return { source, title, callCount }
}
