import type { Editor, JSONContent } from "@tiptap/core"

import type { PromptInputBlock } from "@/lib/types"

import { isEmbeddedReferenceUri } from "./reference-uri"

/**
 * Send serialization: turn the composer document into the prose portion of a
 * `PromptInputBlock[]`. (Out-of-band image / embedded-byte attachments are
 * appended by the host's `buildDraft`; this function owns only the editor doc.)
 *
 * Every reference EXCEPT an embedded-attachment ref serializes **inline, in
 * place**, via the node's own `renderMarkdown` (see
 * {@link "./reference-text".referenceToMarkdown}):
 *
 * - **file** references render as an inline `[label](file://uri)` Markdown link
 *   at the exact position they were typed. They are deliberately *not* lifted
 *   into trailing `resource_link` blocks: codeg keeps no copy of the user's
 *   prompt, so on cold reload the message is reparsed from the agent's own
 *   session file — and only what stays inline in the text survives at its
 *   original position. A trailing ResourceLink ends up stored/reparsed at the
 *   *end* of the message (or dropped entirely — e.g. Claude's parser ignores the
 *   resulting `document` block), which is why a file badge used to jump to the
 *   end of the bubble after reopening a conversation. Keeping the link inline
 *   fixes that for every agent. For a local `file://` an ACP ResourceLink only
 *   conveys the path anyway — identical information to the inline link — so
 *   nothing is lost on the agent side.
 * - **session / commit** references (a `codeg://` uri the agent can't fetch) and
 *   **agent / skill** references stay inline as their text/link form, unchanged.
 * - **embedded** references (a `codeg://embedded/…` display uri for path-less
 *   pasted bytes) are dropped from the prose: their real bytes-bearing block is
 *   appended separately by the host's `buildDraft` (keyed on the same uri via the
 *   send-time payload map), so emitting their synthetic display link here would
 *   leak a uri the agent shouldn't see.
 *
 * The whole document serializes to a single text block (no mid-paragraph
 * fragmentation), with every reference sitting inline exactly where the sender
 * placed it.
 */
export function docToPromptBlocks(editor: Editor): PromptInputBlock[] {
  const doc = editor.getJSON()
  const stripped = stripEmbeddedReferences(doc)
  const text = serializeMarkdown(editor, stripped).trim()
  return text ? [{ type: "text", text }] : []
}

/** A display-only embedded-attachment reference (`codeg://embedded/…`): dropped
 *  from the prose here, its bytes appended out of band by the host. The
 *  synthetic uri points at no fetchable target, so it must never reach the
 *  agent — neither inline nor as a ResourceLink. */
function isEmbeddedReference(node: JSONContent): boolean {
  return (
    node.type === "reference" &&
    typeof node.attrs?.uri === "string" &&
    isEmbeddedReferenceUri(node.attrs.uri)
  )
}

/**
 * Deep-clone `node`, dropping every embedded-attachment reference from the inline
 * content (the host emits their bytes-bearing blocks separately). Every other
 * node — including file references, which serialize to an inline
 * `[label](file://uri)` link — is left intact so it stays in place in the prose.
 * Dropping (rather than replacing with placeholder text) leaves the surrounding
 * prose untouched; any incidental double space collapses on render and is
 * harmless to the agent.
 */
function stripEmbeddedReferences(node: JSONContent): JSONContent {
  if (!node.content) return node
  const content: JSONContent[] = []
  for (const child of node.content) {
    if (isEmbeddedReference(child)) {
      continue
    }
    content.push(stripEmbeddedReferences(child))
  }
  return { ...node, content }
}

/** The Markdown manager is always present (the Markdown extension is always loaded). */
function serializeMarkdown(editor: Editor, doc: JSONContent): string {
  if (!editor.markdown) throw new Error("Markdown extension not loaded")
  return editor.markdown.serialize(doc)
}
