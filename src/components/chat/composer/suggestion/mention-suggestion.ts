import { Extension } from "@tiptap/core"
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion"

/** Live render state the plugin pushes to React while the `@` panel is open. */
export interface MentionRenderState {
  query: string
  /** Document range covering `@` + query, replaced when a row is chosen. */
  range: { from: number; to: number }
  /**
   * Live caret-rect getter (viewport coords), or null if unknown. Call it at
   * position time — not once at trigger time — so the popup re-anchors to the
   * current caret after a window resize, editor scroll, or page scroll while it
   * is open.
   */
  getClientRect: (() => DOMRect | null) | null
}

/**
 * Callbacks the React layer supplies so the suggestion plugin can drive a React
 * popup that lives in the editor's component tree (where data hooks work). The
 * plugin owns trigger detection; React owns data + rendering + insertion.
 */
export interface MentionController {
  onStart: (state: MentionRenderState) => void
  onUpdate: (state: MentionRenderState) => void
  onExit: () => void
  /** Forwarded keydown; return true if the popup consumed it. */
  onKeyDown: (event: KeyboardEvent) => boolean
}

export interface MentionSuggestionOptions {
  controller: MentionController
}

const NOOP_CONTROLLER: MentionController = {
  onStart: () => {},
  onUpdate: () => {},
  onExit: () => {},
  onKeyDown: () => false,
}

function toRenderState(props: SuggestionProps): MentionRenderState {
  return {
    query: props.query,
    range: props.range,
    // Keep the getter itself (not a snapshot) so reposition reads live coords.
    getClientRect: props.clientRect ?? null,
  }
}

/**
 * Tiptap extension wiring `@tiptap/suggestion` (trigger `@`) to a
 * {@link MentionController}. Data fetching, rendering and insertion are handled
 * by the controller's React popup, so the plugin's own `items`/`command` are
 * intentionally inert.
 */
export const MentionSuggestion = Extension.create<MentionSuggestionOptions>({
  name: "mentionSuggestion",

  addOptions() {
    return { controller: NOOP_CONTROLLER }
  },

  addProseMirrorPlugins() {
    const controller = this.options.controller
    return [
      Suggestion({
        editor: this.editor,
        char: "@",
        allowSpaces: false,
        items: () => [],
        command: () => {},
        // Don't trigger mid-IME-composition or inside code blocks.
        allow: ({ editor, state }) => {
          if (editor.view.composing) return false
          return !state.selection.$from.parent.type.spec.code
        },
        render: () => ({
          onStart: (props) => controller.onStart(toRenderState(props)),
          onUpdate: (props) => controller.onUpdate(toRenderState(props)),
          onExit: () => controller.onExit(),
          onKeyDown: (props) => controller.onKeyDown(props.event),
        }),
      }),
    ]
  },
})
