import type { Editor } from "@tiptap/core"

import type { PromptInputBlock } from "@/lib/types"

import type { InputAttachment } from "../message-input-attachments"
import { blocksToRestoredDraft } from "./from-prompt-blocks"

/**
 * Whether the composer has nothing sendable. Stricter than `editor.isEmpty`,
 * which is false for a whitespace-only document (the legacy textarea gated the
 * send button on `text.trim()`), but still treats a document holding only an
 * inline reference badge (e.g. an `@file` mention with no prose) as sendable.
 */
export function isComposerEmpty(editor: Editor): boolean {
  if (editor.isEmpty) return true
  if (editor.getText().trim().length > 0) return false
  let hasReference = false
  editor.state.doc.descendants((node) => {
    if (hasReference) return false
    if (node.type.name === "reference") {
      hasReference = true
      return false
    }
    return true
  })
  return !hasReference
}

/**
 * Inject `prefix + expertId + " "` as the leading token of the message — experts
 * are whole-turn directives the agent inspects first, so they go at the very
 * front, never at the caret.
 *
 * The prefix must be the FIRST token of the *serialized* Markdown. Inserting
 * inline at position 1 only achieves that when the first block is a paragraph;
 * for a heading/list/quote/code block the Markdown marker (`# `, `- `, `> `, …)
 * would serialize before the prefix, so a fresh paragraph is prepended instead.
 * When the first block is a paragraph already carrying an expert prefix (from a
 * prior click), it is replaced rather than stacked — the agent only honors the
 * first directive.
 */
export function applyExpertPrefix(
  editor: Editor,
  prefix: string,
  expertId: string,
  knownExpertIds: ReadonlySet<string>
): void {
  const insertion = `${prefix}${expertId} `
  const first = editor.state.doc.firstChild

  if (first && first.type.name !== "paragraph") {
    editor
      .chain()
      .focus()
      .insertContentAt(0, {
        type: "paragraph",
        content: [{ type: "text", text: insertion }],
      })
      .setTextSelection(insertion.length + 1)
      .run()
    return
  }

  const leading = first
    ? first.textBetween(0, Math.min(first.content.size, 80), undefined, " ")
    : ""
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const existing = leading.match(
    new RegExp(`^${escapedPrefix}([A-Za-z0-9_-]+)\\s`)
  )
  const replaceLen =
    existing && knownExpertIds.has(existing[1]) ? existing[0].length : 0

  // Position 1 is just inside the first block (after its opening boundary).
  let chain = editor.chain().focus()
  if (replaceLen > 0) {
    chain = chain.deleteRange({ from: 1, to: 1 + replaceLen })
  }
  chain
    .insertContentAt(1, insertion)
    .setTextSelection(1 + insertion.length)
    .run()
}

/**
 * Replay a previously-sent `PromptInputBlock[]` (a queued message's draft) back
 * into the editor: prose + reference badges in order, returning the out-of-band
 * attachments (images / embedded resources / non-composer links) for the host to
 * set. Inverse of `docToPromptBlocks` for the queue-edit round-trip. The editor
 * is cleared first so this fully replaces the current content.
 */
export function restoreBlocksIntoEditor(
  editor: Editor,
  blocks: PromptInputBlock[]
): InputAttachment[] {
  const { segments, attachments } = blocksToRestoredDraft(blocks)
  let chain = editor.chain().clearContent()
  for (const segment of segments) {
    chain =
      segment.kind === "markdown"
        ? chain.insertContent(segment.text, { contentType: "markdown" })
        : chain.insertReference(segment.attrs)
  }
  chain.focus("end").run()
  return attachments
}
