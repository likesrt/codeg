import { Editor, type JSONContent } from "@tiptap/core"
import { Markdown } from "@tiptap/markdown"
import StarterKit from "@tiptap/starter-kit"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { buildComposerExtensions } from "./editor-config"

/**
 * The composer must never fabricate a link from a filename or path. linkifyjs
 * treats a filename whose extension is a real TLD (`lib.rs`, `notes.md`,
 * `setup.io`, …) as a domain; left on, that opens a browser on click AND
 * rewrites the outgoing message to `[lib.rs](http://lib.rs)` on serialize.
 * {@link buildComposerExtensions} closes both linkify entry points — the
 * autolink-on-type plugin and the always-installed paste rule — via
 * `shouldAutoLink: () => false`, plus the `autolink` / `linkOnPaste` /
 * `openOnClick` flags. The separate `marked`-based markdown parser (reached only
 * when authored markdown is hydrated) is covered by its own block below.
 */

/** True when any node in the doc carries a `link` mark. */
function hasLinkMark(doc: JSONContent): boolean {
  let found = false
  const walk = (node: JSONContent) => {
    if (node.marks?.some((mark) => mark.type === "link")) found = true
    node.content?.forEach(walk)
  }
  walk(doc)
  return found
}

function makeEditor(): Editor {
  return new Editor({ extensions: buildComposerExtensions() })
}

describe("composer never fabricates links from typed or pasted text", () => {
  // ProseMirror's paste-rule path constructs a ClipboardEvent, which jsdom (v25)
  // does not implement. A minimal polyfill lets `applyPasteRules: true` exercise
  // the real paste rule — the actual vector behind the reported bug — headlessly.
  // Saved/restored so it can never leak into other suites in this worker.
  const globals = globalThis as Record<string, unknown>
  const savedClipboardEvent = globals.ClipboardEvent
  const savedDataTransfer = globals.DataTransfer
  beforeAll(() => {
    class FakeDataTransfer {
      private store: Record<string, string> = {}
      files: unknown[] = []
      setData(type: string, value: string) {
        this.store[type] = value
      }
      getData(type: string) {
        return this.store[type] ?? ""
      }
      get types() {
        return Object.keys(this.store)
      }
    }
    class FakeClipboardEvent extends Event {
      clipboardData: FakeDataTransfer
      constructor(
        type: string,
        init: { clipboardData?: FakeDataTransfer } = {}
      ) {
        super(type)
        this.clipboardData = init.clipboardData ?? new FakeDataTransfer()
      }
    }
    globals.ClipboardEvent = FakeClipboardEvent
    globals.DataTransfer = FakeDataTransfer
  })
  afterAll(() => {
    globals.ClipboardEvent = savedClipboardEvent
    globals.DataTransfer = savedDataTransfer
  })

  it("disables every link-fabrication / navigation option", () => {
    const editor = makeEditor()
    const link = editor.extensionManager.extensions.find(
      (extension) => extension.name === "link"
    )
    expect(link).toBeDefined()
    expect(link?.options.autolink).toBe(false)
    expect(link?.options.linkOnPaste).toBe(false)
    expect(link?.options.openOnClick).toBe(false)
    // The gate that governs BOTH linkify entry points (autolink plugin + paste
    // rule). Default linkify returns true for these domain-shaped tokens; our
    // override is what keeps them plain.
    expect(link?.options.shouldAutoLink("lib.rs")).toBe(false)
    expect(link?.options.shouldAutoLink("notes.md")).toBe(false)
    expect(link?.options.shouldAutoLink("https://example.com")).toBe(false)
    editor.destroy()
  })

  // Pins the assumption the whole fix rests on: an unconfigured StarterKit DOES
  // autolink a pasted filename token via the paste rule (which ignores
  // `autolink`/`linkOnPaste` and consults only `shouldAutoLink`). If a Tiptap
  // upgrade ever stops doing this, this test fails — a signal that the
  // regressions below would otherwise have gone silently vacuous.
  it("baseline: unconfigured StarterKit autolinks a pasted filename token", () => {
    const editor = new Editor({ extensions: [StarterKit, Markdown] })
    editor.commands.insertContent("lib.rs ", { applyPasteRules: true })
    expect(hasLinkMark(editor.getJSON())).toBe(true)
    expect(editor.getMarkdown()).toContain("](http")
    editor.destroy()
  })

  it("does not autolink a pasted filename token (the reported bug)", () => {
    const editor = makeEditor()
    // `applyPasteRules: true` runs the same paste rule a real clipboard paste
    // would, so this exercises the actual reported action.
    editor.commands.insertContent("lib.rs ", { applyPasteRules: true })
    expect(hasLinkMark(editor.getJSON())).toBe(false)
    expect(editor.getMarkdown()).not.toContain("](http")
    editor.destroy()
  })

  it("does not autolink a filename token typed at a word boundary", () => {
    const editor = makeEditor()
    // The autolink-on-type plugin (separate from the paste rule) fires at a
    // word boundary — the trailing space arms it.
    editor.commands.insertContent("see notes.md ")
    expect(hasLinkMark(editor.getJSON())).toBe(false)
    expect(editor.getMarkdown()).not.toContain("](http")
    editor.destroy()
  })
})

describe("composer markdown hydration links", () => {
  // The `marked`-based markdown parser (`contentType: "markdown"`) runs only
  // when AUTHORED markdown is hydrated — drafts, queue-edits, quick messages,
  // `setMarkdown` — never when plain text is typed/pasted. It does not consult
  // `shouldAutoLink`, so it is covered separately here.

  it("does not autolink a filename or path hydrated from markdown", () => {
    // The reported bug class (a file reference becoming a link) must stay closed
    // on the hydration path too — marked never autolinks a bare filename.
    const editor = makeEditor()
    editor.commands.setContent("lib.rs", { contentType: "markdown" })
    expect(hasLinkMark(editor.getJSON())).toBe(false)
    editor.commands.setContent("/Users/a/main.rs", { contentType: "markdown" })
    expect(hasLinkMark(editor.getJSON())).toBe(false)
    editor.destroy()
  })

  it("autolinks a real bare URL hydrated from markdown (intended GFM behavior)", () => {
    // A genuine URL in restored/authored content still renders as a link — by
    // design, and now non-navigating (openOnClick is off). This documents the
    // boundary of the no-fabrication invariant, which covers filenames/paths.
    const editor = makeEditor()
    editor.commands.setContent("https://example.com", {
      contentType: "markdown",
    })
    expect(hasLinkMark(editor.getJSON())).toBe(true)
    editor.destroy()
  })

  it("still parses an explicit markdown link into a link mark", () => {
    const editor = makeEditor()
    const markdown = editor.markdown
    if (!markdown) throw new Error("Markdown extension not loaded")
    // The Link mark is kept — only plain-text fabrication is off — so genuine
    // `[label](uri)` content keeps round-tripping.
    expect(hasLinkMark(markdown.parse("see [docs](https://example.com)"))).toBe(
      true
    )
    editor.destroy()
  })
})
