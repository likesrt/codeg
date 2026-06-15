import { Editor } from "@tiptap/core"
import type { JSONContent } from "@tiptap/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { buildComposerExtensions } from "./editor-config"
import { referenceToMarkdown } from "./reference-text"

/**
 * Headless editor sharing the exact extension set the live composer uses, so
 * these round-trips reflect what users actually type. This is the most reliable
 * automated de-risk for Phase 0 (IME / auto-grow need a real browser).
 */
function makeEditor(): Editor {
  return new Editor({ extensions: buildComposerExtensions() })
}

/** The Markdown manager is always present (Markdown extension is always loaded). */
function markdown(editor: Editor) {
  if (!editor.markdown) {
    throw new Error("Markdown extension not loaded")
  }
  return editor.markdown
}

function parse(editor: Editor, md: string): JSONContent {
  return markdown(editor).parse(md)
}

function serialize(editor: Editor, doc: JSONContent): string {
  return markdown(editor).serialize(doc)
}

/** Collect every mark type name appearing anywhere in the doc tree. */
function markNames(node: JSONContent): Set<string> {
  const names = new Set<string>()
  const walk = (n: JSONContent) => {
    n.marks?.forEach((m) => names.add(m.type))
    n.content?.forEach(walk)
  }
  walk(node)
  return names
}

/** Collect every node type name appearing anywhere in the doc tree. */
function nodeNames(node: JSONContent): Set<string> {
  const names = new Set<string>()
  const walk = (n: JSONContent) => {
    if (n.type) names.add(n.type)
    n.content?.forEach(walk)
  }
  walk(node)
  return names
}

describe("composer markdown engine", () => {
  let editor: Editor

  beforeEach(() => {
    editor = makeEditor()
  })

  afterEach(() => {
    editor?.destroy()
  })

  describe("parse produces the expected structure", () => {
    it("parses bold", () => {
      expect(markNames(parse(editor, "a **b** c"))).toContain("bold")
    })

    it("parses italic", () => {
      expect(markNames(parse(editor, "a *b* c"))).toContain("italic")
    })

    it("parses inline code", () => {
      expect(markNames(parse(editor, "use `x` here"))).toContain("code")
    })

    it("parses a heading with the right level", () => {
      const doc = parse(editor, "## Title")
      const heading = doc.content?.find((n) => n.type === "heading")
      expect(heading).toBeDefined()
      expect(heading?.attrs?.level).toBe(2)
    })

    it("parses a bullet list", () => {
      expect(nodeNames(parse(editor, "- one\n- two"))).toContain("bulletList")
    })

    it("parses an ordered list", () => {
      expect(nodeNames(parse(editor, "1. one\n2. two"))).toContain(
        "orderedList"
      )
    })

    it("parses a blockquote", () => {
      expect(nodeNames(parse(editor, "> quoted"))).toContain("blockquote")
    })

    it("parses a fenced code block", () => {
      expect(nodeNames(parse(editor, "```\nconst x = 1\n```"))).toContain(
        "codeBlock"
      )
    })
  })

  describe("serialize(parse(md)) is stable (idempotent)", () => {
    // Markdown has many equivalent spellings, so we assert stability of the
    // serializer's canonical form rather than byte-equality with the input.
    it.each([
      ["bold", "a **b** c"],
      ["italic", "a *b* c"],
      ["inline code", "use `x` here"],
      ["heading", "## Title"],
      ["bullet list", "- one\n- two"],
      ["ordered list", "1. one\n2. two"],
      ["blockquote", "> quoted"],
      ["code block", "```\nconst x = 1\n```"],
      ["mixed", "# Title\n\nSome **bold** and `code`.\n\n- a\n- b\n\n> note"],
      ["cjk", "你好，**世界**，这是 `代码`。"],
    ])("%s", (_name, md) => {
      const once = serialize(editor, parse(editor, md))
      const twice = serialize(editor, parse(editor, once))
      expect(twice).toBe(once)
      expect(once.length).toBeGreaterThan(0)
    })
  })

  describe("editor.getMarkdown() reflects typed content", () => {
    it("serializes inserted markdown content back to markdown", () => {
      editor.commands.setContent("Hello **world**", { contentType: "markdown" })
      const md = editor.getMarkdown()
      expect(md).toContain("**world**")
    })

    it("round-trips a heading through getMarkdown", () => {
      editor.commands.setContent("# Heading", { contentType: "markdown" })
      expect(editor.getMarkdown().trim()).toBe("# Heading")
    })

    it("preserves CJK text", () => {
      editor.commands.setContent("发送给智能体的消息", {
        contentType: "markdown",
      })
      expect(editor.getMarkdown()).toContain("发送给智能体的消息")
    })
  })

  describe("reference serialization is injection-safe", () => {
    function countLinks(node: JSONContent): number {
      let count = 0
      const walk = (n: JSONContent) => {
        if (n.marks?.some((m) => m.type === "link")) count += 1
        n.content?.forEach(walk)
      }
      walk(node)
      return count
    }

    it("a crafted reference uri yields exactly one link when re-parsed", () => {
      // If the destination weren't fully escaped, the parser would split this
      // into a second `[pwn](http://evil)` link.
      const md = referenceToMarkdown({
        refType: "file",
        id: "",
        label: "f",
        uri: "file:///a/\\> [pwn](http://evil)",
        meta: null,
      })
      expect(countLinks(parse(editor, md))).toBe(1)
    })

    it.each([
      ["bracket breakout", "a](http://evil) x"],
      ["inline-link injection", "a[foo](http://evil)"],
      ["autolink injection", "see <http://evil> now"],
    ])(
      "a crafted reference label (%s) yields exactly one link when re-parsed",
      (_name, label) => {
        const md = referenceToMarkdown({
          refType: "session",
          id: "1",
          label,
          uri: "codeg://session/1",
          meta: null,
        })
        expect(countLinks(parse(editor, md))).toBe(1)
      }
    )

    it.each([
      ["bare url", "http://evil.com"],
      ["www", "www.evil.com"],
      ["email", "user@evil.com"],
      ["image-shaped", "![x](http://evil)"],
    ])(
      "a no-uri reference label (%s) produces no link when re-parsed",
      (_name, label) => {
        const md = referenceToMarkdown({
          refType: "file",
          id: "",
          label,
          uri: null,
          meta: null,
        })
        expect(countLinks(parse(editor, md))).toBe(0)
      }
    )

    it("a URL-like agent label produces no link when re-parsed", () => {
      const md = referenceToMarkdown({
        refType: "agent",
        id: "x",
        label: "http://evil.com",
        uri: null,
        meta: null,
      })
      expect(countLinks(parse(editor, md))).toBe(0)
    })
  })
})
