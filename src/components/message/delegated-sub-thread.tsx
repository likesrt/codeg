"use client"

/**
 * Inline rendering of a delegated child sub-session under the parent's
 * `delegate_to_agent` ToolCallBlock. Renders as a self-contained card —
 * never falls through the generic tool-call shell — so users see "Agent
 * delegating: task" instead of "mcp__codeg-delegate__delegate_to_agent: codex".
 *
 * Layout:
 *   * Header (always visible): AgentIcon + agent name · "delegated" label
 *     + status badge + chevron.
 *   * Task row: the prompt the parent sent to the child.
 *   * Expanded body: scrollable preview of the child's turns. Fetched
 *     lazily on first expand.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { ChevronDown, ChevronRight, Eye, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { AgentIcon } from "@/components/agent-icon"
import { MessageResponse } from "@/components/ai-elements/message"
import { useDelegatedSubSession } from "@/hooks/use-delegated-sub-session"
import { AGENT_LABELS, type AgentType } from "@/lib/types"
import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"
import {
  type DelegationStatus,
  useDelegation,
} from "@/contexts/delegation-context"
import {
  useAcpActions,
  useConnectionStore,
  type ConnectionState,
  type PendingPermission as ChildPendingPermission,
} from "@/contexts/acp-connections-context"
import { PermissionDialog } from "@/components/chat/permission-dialog"
import { StatusBadge } from "@/components/message/delegation-status-badge"
import { SubAgentSessionSheet } from "@/components/message/sub-agent-session-sheet"

interface Props {
  parentToolUseId: string
  /** Raw JSON arguments the LLM sent to `delegate_to_agent`. Used to
   *  surface the task and agent_type before the broker's
   *  DelegationStarted event lands (or when binding never arrives — e.g.
   *  the wider session was reloaded with an inline child still around). */
  input?: string | null
  output?: string | null
  errorText?: string | null
  state?: ToolCallState
  /**
   * ACP extensibility metadata on this tool call. Read here as a
   * tertiary fallback after the live `DelegationContext` binding when
   * the parent UI re-mounted on a page refresh and the live
   * `delegation_started` event was already consumed (lost): the
   * snapshot's `ToolCallState.meta["codeg.delegation"]` carries enough
   * to re-bind the card to the child conversation.
   */
  meta?: Record<string, unknown> | null
}

type ParsedInput = {
  agentType: AgentType | null
  task: string | null
  workingDir: string | null
}

const KNOWN_AGENT_TYPES: ReadonlySet<string> = new Set<AgentType>([
  "claude_code",
  "codex",
  "open_code",
  "gemini",
  "cline",
  "open_claw",
])

// Module-level empty map so the reducer's initial state has a stable
// reference across mounts. New entries are always inserted into a
// fresh `new Map(state)` copy, so the constant itself stays frozen.
const EMPTY_TURN_MAP: ReadonlyMap<string, string> = new Map()

/**
 * Subscribe to the child connection's `ConnectionState` (live message,
 * pending permission, etc.) from the shared connections store. Returns
 * `undefined` while no synthetic entry exists yet — caller falls back to
 * the binding / persisted-turns view. Re-renders on every state change
 * via `useSyncExternalStore`.
 */
function useDelegationChildLive(
  childConnectionId: string | null
): ConnectionState | undefined {
  const store = useConnectionStore()
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!childConnectionId) return () => {}
      return store.subscribeKey(childConnectionId, cb)
    },
    [store, childConnectionId]
  )
  const getSnapshot = useCallback(
    () =>
      childConnectionId ? store.getConnection(childConnectionId) : undefined,
    [store, childConnectionId]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

type ParsedMeta = {
  status: DelegationStatus
  childConnectionId: string | null
  childConversationId: number | null
  errorCode: string | null
  /** Inline result preview written by the broker on the terminal `completed`
   *  meta, so a post-refresh snapshot can render the result without the live
   *  event. `null` for running/failed metas. */
  resultPreview: string | null
}

/**
 * Extract delegation state from a `ToolCallState.meta` value. Returns
 * `null` when the meta doesn't carry the `codeg.delegation` sub-object —
 * caller falls back to the live binding / `parseInput` chain.
 *
 * The shape mirrors what the broker writes via `DelegationMetaWriter`:
 *   `{ "codeg.delegation": { status, child_connection_id?,
 *     child_conversation_id?, error_code? } }`
 */
function parseDelegationMeta(
  meta: Record<string, unknown> | null | undefined
): ParsedMeta | null {
  if (!meta || typeof meta !== "object") return null
  const inner = meta["codeg.delegation"]
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null
  const obj = inner as Record<string, unknown>
  const rawStatus = obj["status"]
  let status: DelegationStatus
  switch (rawStatus) {
    case "running":
    case "pending":
      status = "running"
      break
    case "completed":
    case "ok":
      status = "ok"
      break
    case "failed":
    case "err":
      status = "err"
      break
    default:
      return null
  }
  const child_connection_id = obj["child_connection_id"]
  const child_conversation_id = obj["child_conversation_id"]
  const error_code = obj["error_code"]
  const text_preview = obj["text_preview"]
  return {
    status,
    childConnectionId:
      typeof child_connection_id === "string" ? child_connection_id : null,
    childConversationId:
      typeof child_conversation_id === "number" ? child_conversation_id : null,
    errorCode: typeof error_code === "string" ? error_code : null,
    resultPreview: typeof text_preview === "string" ? text_preview : null,
  }
}

const EMPTY_PARSED_INPUT: ParsedInput = {
  agentType: null,
  task: null,
  workingDir: null,
}

// Wrapper keys that hosts use to nest the actual tool arguments. JSON-RPC
// servers and various MCP relays will pack the call as `{name, arguments}`
// or `{params: {...}}`; some agents stash the args under a generic
// `input`/`payload` key alongside metadata. Walked recursively (small
// depth cap) so any single layer of wrapping peels off without false
// positives on legitimate shallow fields.
const ARGS_WRAPPER_KEYS = [
  "arguments",
  "input",
  "params",
  "payload",
  "_meta",
] as const

function findDelegationArgs(
  value: unknown,
  depth = 0
): Record<string, unknown> | null {
  if (depth > 4) return null
  if (value === null || value === undefined) return null
  // Some hosts double-encode the raw input (JSON-of-JSON). Recurse once
  // on the parsed inner value before giving up.
  if (typeof value === "string") {
    try {
      return findDelegationArgs(JSON.parse(value), depth + 1)
    } catch {
      return null
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  // Direct hit: this object has at least one of the delegation fields
  // declared on its top level.
  if (
    typeof obj.task === "string" ||
    typeof obj.agent_type === "string" ||
    typeof obj.working_dir === "string"
  ) {
    return obj
  }
  for (const key of ARGS_WRAPPER_KEYS) {
    const child = obj[key]
    if (child === undefined) continue
    const found = findDelegationArgs(child, depth + 1)
    if (found) return found
  }
  return null
}

// One-line debug breadcrumb. The walker covers the wrappers we know about
// (`arguments`, `input`, `params`, `payload`, `_meta`); if a non-empty raw
// input still doesn't yield delegation args, the host is using a shape we
// haven't accounted for. Logging a truncated sample makes the next "task
// didn't show up" report self-debugging — the actual wire shape lands in
// the user's devtools instead of needing a repro.
function warnDelegationInputUnparseable(raw: string, reason: string): void {
  const sample = raw.length > 240 ? `${raw.slice(0, 240)}…` : raw
  console.warn(
    `[DelegatedSubThread] could not extract delegation args (${reason}). raw=${sample}`
  )
}

function parseInput(raw: string | null | undefined): ParsedInput {
  if (!raw || typeof raw !== "string") return EMPTY_PARSED_INPUT
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    warnDelegationInputUnparseable(raw, "JSON.parse threw")
    return EMPTY_PARSED_INPUT
  }
  const obj = findDelegationArgs(parsed)
  if (!obj) {
    warnDelegationInputUnparseable(raw, "no known wrapper matched")
    return EMPTY_PARSED_INPUT
  }
  const at = typeof obj.agent_type === "string" ? obj.agent_type : null
  return {
    agentType: at && KNOWN_AGENT_TYPES.has(at) ? (at as AgentType) : null,
    task: typeof obj.task === "string" ? obj.task : null,
    workingDir: typeof obj.working_dir === "string" ? obj.working_dir : null,
  }
}

/**
 * Find the first complete JSON object embedded in `raw` and parse it.
 * Used to recover the broker's envelope from host-specific wrappings —
 * notably Codex, which serializes the MCP `function_call_output` as
 * `"Wall time: N seconds\nOutput:\n<json>"` (sometimes with a trailing
 * terminal-cursor character such as `_`). Direct `JSON.parse(raw)`
 * fails on these because of the textual prefix/suffix; this scanner
 * walks back from the last `}` until a balanced span parses cleanly.
 *
 * Returns null when no `{...}` substring parses. Bounded iteration:
 * each attempt shrinks the candidate by one `}`, so worst-case work is
 * linear in the count of `}` characters in `raw`.
 */
function extractEmbeddedJsonObject(
  raw: string
): Record<string, unknown> | null {
  const start = raw.indexOf("{")
  if (start < 0) return null
  let end = raw.lastIndexOf("}")
  while (end > start) {
    const candidate = raw.slice(start, end + 1)
    try {
      const v = JSON.parse(candidate)
      if (v && typeof v === "object" && !Array.isArray(v)) {
        return v as Record<string, unknown>
      }
    } catch {
      // try a shorter span
    }
    end = raw.lastIndexOf("}", end - 1)
    if (end < 0) break
  }
  return null
}

/**
 * Parsed form of the parent `delegate_to_agent` tool output.
 *
 * Under ASYNC delegation the tool output is a *running ack* — the result
 * arrives later via the `delegation_completed` event / meta, NOT on the tool
 * output. So we must distinguish:
 *   - `ack`     — a running (or otherwise non-terminal) task: there is NO
 *                 result to render on the card yet.
 *   - `outcome` — a terminal result to render (a fast-complete ack where the
 *                 child finished during setup, or a legacy pre-async
 *                 synchronous result).
 * Returning `ack` — rather than letting the raw ack JSON fall through as an
 * "outcome" — is what stops the card from painting the ack as the result and
 * from prematurely flipping the status badge to "ok".
 */
type ParsedToolOutput =
  | { kind: "ack"; childConversationId: number | null }
  | {
      kind: "outcome"
      text: string
      isError: boolean
      childConversationId: number | null
    }

function readChildConversationId(obj: Record<string, unknown>): number | null {
  return typeof obj.child_conversation_id === "number"
    ? obj.child_conversation_id
    : null
}

/**
 * Interpret the broker's inner shape — the async `DelegationTaskReport`
 * (discriminated by `status`) or the legacy synchronous `DelegationOutcome`
 * (discriminated by `kind`). Returns null when neither discriminator is present
 * so the caller can fall through to other unwrapping strategies.
 */
function interpretReport(
  obj: Record<string, unknown>
): ParsedToolOutput | null {
  const childConversationId = readChildConversationId(obj)
  const status = typeof obj.status === "string" ? obj.status : null
  if (status) {
    switch (status) {
      case "running":
      case "unknown":
        // No terminal result to show on the card — it's an ack.
        return { kind: "ack", childConversationId }
      case "completed":
        return {
          kind: "outcome",
          text: typeof obj.text === "string" ? obj.text : "",
          isError: false,
          childConversationId,
        }
      case "failed":
      case "canceled": {
        const message = typeof obj.message === "string" ? obj.message : ""
        const code = typeof obj.error_code === "string" ? obj.error_code : ""
        return {
          kind: "outcome",
          text: message || code || "Delegation failed.",
          isError: true,
          childConversationId,
        }
      }
      default:
        return { kind: "ack", childConversationId }
    }
  }
  // Legacy synchronous outcome shape.
  const kind = typeof obj.kind === "string" ? obj.kind : null
  if (kind === "ok") {
    return {
      kind: "outcome",
      text: typeof obj.text === "string" ? obj.text : "",
      isError: false,
      childConversationId,
    }
  }
  if (kind === "err") {
    const message = typeof obj.message === "string" ? obj.message : ""
    const code = typeof obj.code === "string" ? obj.code : ""
    return {
      kind: "outcome",
      text: message || code || "Delegation failed.",
      isError: true,
      childConversationId,
    }
  }
  return null
}

/**
 * Best-effort parse of the `delegate_to_agent` tool output into a
 * `ParsedToolOutput`. Mirrors the old unwrapping chain (direct JSON →
 * embedded-object scan → MCP `CallToolResult` envelope from
 * `companion.rs::render_task_report`) but yields the ack/outcome tagged union
 * so a running ack is never rendered as a result. `forceError` is set when
 * parsing the tool's `errorText` channel.
 */
function parseToolOutput(
  raw: string | null | undefined,
  forceError = false
): ParsedToolOutput | null {
  if (!raw || typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  let obj: Record<string, unknown> | null = null
  try {
    const v = JSON.parse(trimmed) as unknown
    if (v && typeof v === "object" && !Array.isArray(v)) {
      obj = v as Record<string, unknown>
    } else {
      // Top-level primitive (string/number/bool): render directly.
      return {
        kind: "outcome",
        text: String(v),
        isError: forceError,
        childConversationId: null,
      }
    }
  } catch {
    obj = extractEmbeddedJsonObject(trimmed)
  }

  if (!obj) {
    return {
      kind: "outcome",
      text: trimmed,
      isError: forceError,
      childConversationId: null,
    }
  }

  // MCP `CallToolResult` envelope. Prefer the inner `structuredContent` (the
  // full report); fall back to `content[0].text` when it's missing/malformed.
  if (
    Array.isArray(obj.content) &&
    obj.structuredContent &&
    typeof obj.structuredContent === "object" &&
    !Array.isArray(obj.structuredContent)
  ) {
    const inner = obj.structuredContent as Record<string, unknown>
    const interpreted = interpretReport(inner)
    if (interpreted) {
      // Honor an outer `isError: true` the host already decided.
      if (interpreted.kind === "outcome" && obj.isError === true) {
        return { ...interpreted, isError: true }
      }
      return interpreted
    }
    const first = (obj.content as unknown[])[0]
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const text = (first as Record<string, unknown>).text
      if (typeof text === "string") {
        return {
          kind: "outcome",
          text,
          isError: obj.isError === true || forceError,
          childConversationId: readChildConversationId(inner),
        }
      }
    }
  }

  const interpreted = interpretReport(obj)
  if (interpreted) {
    if (interpreted.kind === "outcome" && forceError) {
      return { ...interpreted, isError: true }
    }
    return interpreted
  }

  // Unrecognized JSON — pretty-print so we don't surface raw braces.
  return {
    kind: "outcome",
    text: "```json\n" + JSON.stringify(obj, null, 2) + "\n```",
    isError: forceError,
    childConversationId: null,
  }
}

export function DelegatedSubThread({
  parentToolUseId,
  input,
  output,
  errorText,
  state,
  meta,
}: Props) {
  const t = useTranslations("Folder.chat.delegation")
  const [sheetOpen, setSheetOpen] = useState(false)
  // expanded is driven by user click OR by the arrival of a child
  // pending permission. useReducer (not useState) so the in-effect
  // auto-expand dispatch on first permission appearance doesn't trip
  // the `react-hooks/set-state-in-effect` lint rule — same pattern as
  // `use-delegated-sub-session.ts`.
  const [expanded, dispatchExpand] = useReducer(
    (prev: boolean, action: "toggle" | "force-open"): boolean => {
      if (action === "force-open") return true
      return !prev
    },
    false
  )
  const parsed = useMemo(() => parseInput(input), [input])
  const parsedMeta = useMemo(() => parseDelegationMeta(meta), [meta])
  const { findByParentToolUseId } = useDelegation()
  const { attachDelegationChild, respondPermission } = useAcpActions()
  // `enabled: false` — we no longer surface the child conversation's
  // intermediate turns in the parent UI (only the broker's final outcome
  // text), so there's no reason to fetch the persisted detail. The hook
  // is still useful for the `binding` it returns (agent type, status,
  // child ids derived from the live `DelegationContext` map).
  const { binding } = useDelegatedSubSession(parentToolUseId, {
    enabled: false,
  })

  // Live view of the child connection's streaming state. Drives the
  // expanded body's "streaming" branch — text/thinking/tool-call deltas
  // reach this card the moment they arrive on the child's ACP stream,
  // not just after the broker resolves.
  const childConnectionId =
    binding?.childConnectionId ?? parsedMeta?.childConnectionId ?? null
  const childLive = useDelegationChildLive(childConnectionId)
  const childPendingPermission = childLive?.pendingPermission ?? null

  // Auto-expand the card the *first* time the child raises a permission
  // request — the user has to act on it. Tracked via a ref so a user
  // who deliberately collapses afterwards isn't forced back open on
  // every reducer notify (the request_id stays the same across
  // re-renders).
  const lastSeenPermissionIdRef = useRef<string | null>(null)
  useEffect(() => {
    const reqId = childPendingPermission?.request_id ?? null
    if (reqId && reqId !== lastSeenPermissionIdRef.current) {
      lastSeenPermissionIdRef.current = reqId
      dispatchExpand("force-open")
    }
    if (!reqId) {
      lastSeenPermissionIdRef.current = null
    }
  }, [childPendingPermission])

  // Inline approve/deny — dispatch via the child connection's id, not
  // the parent's. PermissionDialog already routes via the connectionId
  // passed at construction time; for delegation the only consumer is
  // this card, so wiring the child's id directly here is sufficient.
  const onRespondPermission = useCallback(
    (requestId: string, optionId: string) => {
      if (!childConnectionId) return
      void respondPermission(childConnectionId, requestId, optionId)
    },
    [childConnectionId, respondPermission]
  )

  // Snapshot-recovery seed: when the parent's tool-call snapshot carries
  // `meta["codeg.delegation"] = { status: "running", child_connection_id }`
  // but the live `delegation_started` event has already been consumed
  // (e.g. page refresh mid-delegation), pull the child connection into
  // the reducer here so its streaming text reaches this card. Idempotent
  // because `attachDelegationChild` early-returns when the synthetic
  // entry already exists.
  useEffect(() => {
    const liveBinding = findByParentToolUseId(parentToolUseId)
    if (!parsedMeta) return
    if (parsedMeta.status !== "running") return
    if (!parsedMeta.childConnectionId) return
    if (liveBinding) return
    if (!parsed.agentType) return
    attachDelegationChild({
      connectionId: parsedMeta.childConnectionId,
      // We don't know the parent's connection_id at this layer (the
      // ToolCallPart doesn't carry it). Pass an empty string — the
      // synthetic ConnectionState only uses parentConnectionId for
      // diagnostic / cascade-cancel hooks; the routing of incoming
      // events is by child connection_id alone.
      parentConnectionId: "",
      parentToolUseId,
      agentType: parsed.agentType,
    })
  }, [
    attachDelegationChild,
    findByParentToolUseId,
    parentToolUseId,
    parsed.agentType,
    parsedMeta,
  ])

  // Prefer binding-derived state (live event stream) when present, then
  // the persisted `meta["codeg.delegation"]` from the snapshot (page
  // refresh recovery), then the parent ToolCall's own state/output as a
  // last resort.
  // Parse the parent `delegate_to_agent` tool output once. Under async this is
  // a running *ack* (kind:"ack") while the child runs; a terminal kind:"outcome"
  // only for a fast-complete (child finished during setup) or a legacy
  // synchronous result. `errorText` (tool errored) is forced to an error
  // outcome.
  const toolOutput = useMemo<ParsedToolOutput | null>(() => {
    if (errorText) {
      const parsed = parseToolOutput(errorText, true)
      if (parsed) return parsed
    }
    return parseToolOutput(output)
  }, [output, errorText])

  const agentType: AgentType | null = binding?.agentType ?? parsed.agentType
  const status: "starting" | "running" | "ok" | "err" = (() => {
    if (binding) return binding.status
    if (parsedMeta) return parsedMeta.status
    if (state === "output-error" || errorText) return "err"
    // Async: the parent output is a running ack while the child runs in the
    // background — keep showing "running" rather than letting output-available
    // prematurely flip the badge to "ok" (the result lands later via the
    // event/meta). A terminal report (fast-complete / legacy sync) maps to
    // ok/err directly.
    if (toolOutput?.kind === "ack") return "running"
    if (toolOutput?.kind === "outcome") return toolOutput.isError ? "err" : "ok"
    if (state === "output-available") return "ok"
    // No live binding, no persisted meta, and the parent tool call hasn't
    // reached a terminal state yet: the sub-agent connection is still being
    // set up (the broker is correlating the tool_call, spawning the agent,
    // handshaking, and creating the child conversation) and the
    // `delegation_started` event hasn't bound this card to a child session.
    // Kept distinct from "running" so the card neither claims the sub-agent
    // is already working nor offers an expand that could only show a spinner.
    // Flips to "running"/"ok"/"err" the instant a binding, meta, or terminal
    // output arrives.
    return "starting"
  })()
  const errorCode = binding?.errorCode ?? parsedMeta?.errorCode ?? undefined
  // Inline result preview: live event binding first, then the persisted
  // terminal meta (post-refresh recovery). Rendered by the expanded body when
  // there's no live child stream to show.
  const resultPreview =
    binding?.resultPreview ?? parsedMeta?.resultPreview ?? null
  // The child session isn't bound yet in the "starting" state, so there is
  // nothing meaningful to expand into — keep the header non-interactive
  // (no toggle, no chevron) until a child session exists.
  const expandable = status !== "starting"

  // A terminal result to render in the expanded body. Only a kind:"outcome"
  // tool output is a result; a running ack yields no inline outcome (the body
  // falls back to the live child stream / preview instead).
  const outcome = toolOutput?.kind === "outcome" ? toolOutput : null

  // Real-time view of the child's assistant text — *all* text segments
  // concatenated in arrival order, ACROSS turns. We deliberately strip:
  //   - thinking blocks (internal reasoning, not the result)
  //   - tool_call / plan blocks (intermediate steps)
  // but we keep every text segment so the user sees the child's visible
  // output grow append-only. Once the broker's outcome lands on
  // `output`, `outcome.text` takes over.
  //
  // Cross-turn accumulation: the connections store resets
  // `liveMessage.content` to `[]` on every `STATUS_CHANGED("prompting")`
  // (one fires per child turn), wiping the previous turn's visible
  // text. We keep an id-keyed `Map<turnId, text>` in reducer state so
  // each turn contributes its final text exactly once. Map preserves
  // insertion order, so concatenation matches arrival order. useReducer
  // (not useState) so dispatching in effect doesn't trip the
  // `react-hooks/set-state-in-effect` lint rule — same pattern as the
  // auto-expand block above.
  const [seenTurns, observeTurnText] = useReducer(
    (
      state: ReadonlyMap<string, string>,
      action: { id: string; text: string }
    ): ReadonlyMap<string, string> => {
      if (state.get(action.id) === action.text) return state
      const next = new Map(state)
      next.set(action.id, action.text)
      return next
    },
    EMPTY_TURN_MAP
  )
  useEffect(() => {
    const liveMessage = childLive?.liveMessage
    if (!liveMessage) return
    const parts: string[] = []
    for (const b of liveMessage.content) {
      if (b.type === "text" && b.text.trim().length > 0) parts.push(b.text)
    }
    observeTurnText({ id: liveMessage.id, text: parts.join("") })
  }, [childLive])

  const liveStreamText = useMemo<string | null>(() => {
    const turns: string[] = []
    for (const text of seenTurns.values()) {
      if (text.length > 0) turns.push(text)
    }
    if (turns.length === 0) return null
    return turns.join("\n\n")
  }, [seenTurns])

  // Caller (ToolCallPart) already guarantees this is a `delegate_to_agent`
  // tool, but a snapshot replay with an empty/unparseable input AND no live
  // binding has no useful card to draw — fall through to the standard
  // renderer instead of showing an "unknown sub-agent" stub. Placed AFTER
  // all hooks so the hook order stays stable on re-render.
  if (!binding && !parsed.agentType && !parsed.task) {
    return null
  }

  // Final fallback: the broker's tool output carries `child_conversation_id`
  // even when neither a live binding nor persisted meta exists — the
  // synthetic-fallback case (the broker minted a `delegation-*` tool_use_id, so
  // it skipped meta/event emits). Under async this id rides on the running ack,
  // so reading it from `toolOutput` keeps the "Open detail" affordance working
  // for those cards (their inline status can't auto-resolve, but the child
  // session shows the true terminal result).
  const childConversationId =
    binding?.childConversationId ??
    parsedMeta?.childConversationId ??
    toolOutput?.childConversationId ??
    null

  // Header content (icon + agent name + status badge + task), shared between
  // the interactive toggle (expandable card) and the static, non-interactive
  // row shown in the "starting" state.
  const headerContent = (
    <>
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-background text-foreground">
        {agentType ? (
          <AgentIcon agentType={agentType} className="h-5 w-5" />
        ) : (
          <span className="h-2.5 w-2.5 rounded-sm bg-muted-foreground/60" />
        )}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">
            {agentType ? AGENT_LABELS[agentType] : t("unknownAgent")}
          </span>
          <StatusBadge status={status} errorCode={errorCode} />
        </div>
        {parsed.task && (
          <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words line-clamp-1">
            {parsed.task}
          </div>
        )}
      </div>
    </>
  )

  return (
    <div
      data-testid="delegated-sub-thread"
      className="rounded-lg border border-border bg-card"
    >
      <div className="flex w-full items-stretch rounded-t-lg overflow-hidden">
        {expandable ? (
          <button
            type="button"
            onClick={() => dispatchExpand("toggle")}
            className="flex flex-1 min-w-0 items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
            aria-expanded={expanded}
          >
            {headerContent}
            <span className="shrink-0 text-muted-foreground">
              {expanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </span>
          </button>
        ) : (
          <div className="flex flex-1 min-w-0 items-center gap-3 px-3 py-2.5 text-left">
            {headerContent}
          </div>
        )}
        {childConversationId != null && (
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="shrink-0 flex items-center gap-1.5 px-3 border-l border-border text-xs font-medium text-foreground/80 hover:bg-muted/60 hover:text-foreground transition-colors"
            title={t("openDetail")}
            aria-label={t("openDetail")}
          >
            <Eye className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t("openDetail")}</span>
          </button>
        )}
      </div>
      {expandable && expanded && (
        <div className="border-t border-border px-3 py-3 max-h-96 overflow-auto text-xs space-y-3">
          <ExpandedBody
            status={status}
            outcome={outcome}
            liveStreamText={liveStreamText}
            resultPreview={resultPreview}
            childPendingPermission={childPendingPermission}
            onRespondPermission={onRespondPermission}
            tSubAgentRunning={t("subAgentRunning")}
            tNoDetail={t("noDetail")}
          />
        </div>
      )}
      {childConversationId != null && (
        <SubAgentSessionSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          childConversationId={childConversationId}
          childConnectionId={childConnectionId}
          agentType={agentType}
        />
      )}
    </div>
  )
}

function ExpandedBody({
  status,
  outcome,
  liveStreamText,
  resultPreview,
  childPendingPermission,
  onRespondPermission,
  tSubAgentRunning,
  tNoDetail,
}: {
  status: "starting" | "running" | "ok" | "err"
  outcome: { text: string; isError: boolean } | null
  liveStreamText: string | null
  resultPreview: string | null
  childPendingPermission: ChildPendingPermission | null
  onRespondPermission: (requestId: string, optionId: string) => void
  tSubAgentRunning: string
  tNoDetail: string
}) {
  const hasOutcome = !!outcome && outcome.text.length > 0
  // The body text: the live child stream (accumulated across turns, and
  // retained after the child detaches) takes priority; the recovered terminal
  // preview backs the post-refresh case where no live stream exists.
  const body = liveStreamText ?? resultPreview ?? null

  // Priority:
  //   1. pending permission — child can't progress until the user acts.
  //   2. terminal outcome on the tool output (fast-complete / legacy sync).
  //   3. running: show whatever text we have PLUS a trailing "sub-agent
  //      running…" indicator. The indicator is appended, never substituted.
  //   4. terminal (ok/err) with body text — the result (live full text, or the
  //      recovered preview).
  //   5. noDetail — terminal state with nothing to display.
  if (childPendingPermission) {
    return (
      <PermissionDialog
        permission={childPendingPermission}
        onRespond={onRespondPermission}
      />
    )
  }
  if (hasOutcome) {
    return (
      <DelegationOutcomeText text={outcome!.text} isError={outcome!.isError} />
    )
  }
  if (status === "running") {
    return (
      <div className="space-y-2">
        {body && <DelegationOutcomeText text={body} isError={false} />}
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>{tSubAgentRunning}</span>
        </div>
      </div>
    )
  }
  if (body) {
    return <DelegationOutcomeText text={body} isError={status === "err"} />
  }
  return <div className="text-muted-foreground">{tNoDetail}</div>
}

function DelegationOutcomeText({
  text,
  isError,
}: {
  text: string
  isError: boolean
}) {
  return (
    <div
      className={
        isError
          ? 'text-destructive prose prose-sm dark:prose-invert max-w-none break-words [&_ul]:list-inside [&_ol]:list-inside [&_[data-streamdown="code-block-body"]]:max-h-96 [&_[data-streamdown="code-block-body"]]:overflow-auto'
          : 'prose prose-sm dark:prose-invert max-w-none break-words [&_ul]:list-inside [&_ol]:list-inside [&_[data-streamdown="code-block-body"]]:max-h-96 [&_[data-streamdown="code-block-body"]]:overflow-auto'
      }
    >
      <MessageResponse>{text}</MessageResponse>
    </div>
  )
}
