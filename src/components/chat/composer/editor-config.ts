import type { Extensions } from "@tiptap/core"
import { Markdown } from "@tiptap/markdown"
import { Placeholder } from "@tiptap/extension-placeholder"
import StarterKit from "@tiptap/starter-kit"

import { InactiveSelectionHighlight } from "./inactive-selection"
import { Reference } from "./nodes/reference-node"
import {
  MentionSuggestion,
  type MentionController,
} from "./suggestion/mention-suggestion"

/**
 * Options for the shared composer extension set.
 */
export interface ComposerExtensionOptions {
  /** Placeholder shown when the document is empty. */
  placeholder?: string
  /**
   * When provided, enables the unified `@` mention panel: the suggestion plugin
   * forwards lifecycle/keys to this controller, whose React popup owns data and
   * insertion.
   */
  mentionController?: MentionController
}

/**
 * Build the Tiptap extension set powering the rich-text composer.
 *
 * Shared by the live editor ({@link "./rich-composer".RichComposer}) and the
 * headless editor used in tests, so the Markdown round-trip exercised by tests
 * matches what users actually type.
 *
 * StarterKit (v3) already bundles paragraph/heading/lists/bold/italic/strike/
 * code/codeBlock/blockquote/link/history/hardBreak and the relevant input
 * rules, which gives us live WYSIWYG Markdown. `Markdown` adds
 * `editor.getMarkdown()` / `editor.markdown.parse()` for serialization.
 */
export function buildComposerExtensions(
  options: ComposerExtensionOptions = {}
): Extensions {
  const extensions: Extensions = [
    StarterKit,
    Placeholder.configure({
      placeholder: options.placeholder ?? "",
      // Only paint the placeholder while the editor is editable so a disabled
      // composer reads as empty rather than as a hint.
      showOnlyWhenEditable: true,
    }),
    Markdown,
    Reference,
    // Keeps the selection visible when focus moves to the right-click menu.
    InactiveSelectionHighlight,
  ]
  if (options.mentionController) {
    extensions.push(
      MentionSuggestion.configure({ controller: options.mentionController })
    )
  }
  return extensions
}
