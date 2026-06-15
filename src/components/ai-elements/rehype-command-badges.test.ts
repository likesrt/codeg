import { describe, expect, it } from "vitest"

import { rehypeCommandBadges } from "./rehype-command-badges"

type Node = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

const text = (value: string): Node => ({ type: "text", value })
const el = (
  tagName: string,
  children: Node[],
  properties: Record<string, unknown> = {}
): Node => ({ type: "element", tagName, properties, children })
const root = (children: Node[]): Node => ({ type: "root", children })

function run(tree: Node): Node {
  rehypeCommandBadges()(tree)
  return tree
}

/** All `codeg://skill/…` anchors anywhere in the tree. */
function skillAnchors(node: Node): Node[] {
  const out: Node[] = []
  const walk = (n: Node) => {
    if (
      n.type === "element" &&
      n.tagName === "a" &&
      typeof n.properties?.href === "string" &&
      n.properties.href.startsWith("codeg://skill/")
    ) {
      out.push(n)
    }
    n.children?.forEach(walk)
  }
  walk(node)
  return out
}

const anchorText = (a: Node) =>
  (a.children ?? []).map((c) => c.value ?? "").join("")

describe("rehypeCommandBadges", () => {
  it("badges a `/command` token, keeping the literal prefix", () => {
    const tree = run(root([el("p", [text("run /review please")])]))
    const anchors = skillAnchors(tree)
    expect(anchors).toHaveLength(1)
    expect(anchors[0].properties?.href).toBe("codeg://skill/review")
    expect(anchorText(anchors[0])).toBe("/review")
  })

  it("badges a `$skill` token", () => {
    const tree = run(root([el("p", [text("$deploy now")])]))
    const anchors = skillAnchors(tree)
    expect(anchors).toHaveLength(1)
    expect(anchors[0].properties?.href).toBe("codeg://skill/deploy")
    expect(anchorText(anchors[0])).toBe("$deploy")
  })

  it("badges multiple tokens and preserves the surrounding text", () => {
    const tree = run(root([el("p", [text("/a and $b")])]))
    const p = tree.children![0]
    expect(skillAnchors(tree)).toHaveLength(2)
    // [anchor /a][text " and "][anchor $b]
    expect(p.children).toHaveLength(3)
    expect(p.children![1]).toMatchObject({ type: "text", value: " and " })
  })

  it("does NOT badge a file-ish path (`/usr/bin`)", () => {
    expect(skillAnchors(run(root([el("p", [text("see /usr/bin")])])))).toEqual(
      []
    )
  })

  it("does NOT badge a digit-leading token", () => {
    expect(skillAnchors(run(root([el("p", [text("/123 $5")])])))).toEqual([])
  })

  it("does NOT badge a token glued to a preceding word (`a/b`)", () => {
    expect(skillAnchors(run(root([el("p", [text("a/b x/y")])])))).toEqual([])
  })

  it("skips text inside <code> and <pre>", () => {
    const tree = run(
      root([
        el("p", [el("code", [text("/review")])]),
        el("pre", [el("code", [text("$deploy")])]),
      ])
    )
    expect(skillAnchors(tree)).toEqual([])
  })

  it("skips text inside an existing link (no nested anchors)", () => {
    const tree = run(
      root([
        el("p", [el("a", [text("/review")], { href: "https://example.com" })]),
      ])
    )
    // Only the original non-codeg link remains; no codeg://skill anchor added.
    expect(skillAnchors(tree)).toEqual([])
  })

  it("skips text inside a math element (the `$` belongs to math)", () => {
    const tree = run(
      root([el("span", [text("$x")], { className: ["math", "math-inline"] })])
    )
    expect(skillAnchors(tree)).toEqual([])
  })

  it("leaves a token-free tree untouched (same text node identity)", () => {
    const original = text("hello world")
    const tree = run(root([el("p", [original])]))
    expect(tree.children![0].children![0]).toBe(original)
  })
})
