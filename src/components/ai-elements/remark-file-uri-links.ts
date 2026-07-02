// rehype-harden hard-codes `file:` in its blocked-protocol list and replaces
// such links with `<span>… [blocked]</span>`. Rewriting `file://` hrefs in
// the mdast layer (before remark-rehype) sidesteps the block while keeping
// the link clickable through the existing link-safety + open-file-dialog
// flow. Image syntax is intentionally left untouched: harden's
// "[Image blocked: …]" placeholder is more useful than a broken <img src>.

type MdastNodeLike = {
  type: string
  url?: unknown
  identifier?: unknown
  children?: unknown
}

function fileUriToLocalPath(uri: string): string | null {
  if (!/^file:\/\//i.test(uri)) return null
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return null
  }
  // A non-empty host is a UNC authority: file://server/share/x parses as
  // host="server", pathname="/share/x". Preserve it as //server/share/x
  // instead of dropping to /share/x (a different, local path).
  let path = parsed.host
    ? `//${parsed.host}${parsed.pathname}`
    : parsed.pathname
  if (!parsed.host && /^\/[a-zA-Z]:[\\/]/.test(path)) path = path.slice(1)
  // Keep URL-encoded form so `%23` / `%3F` don't collide with fragment/query
  // boundaries when the click handler later splits on `#` / `?`.
  return `${path}${parsed.search}${parsed.hash}`
}

function walk(node: MdastNodeLike, fn: (n: MdastNodeLike) => void): void {
  fn(node)
  const { children } = node
  if (Array.isArray(children)) {
    for (const child of children) {
      walk(child as MdastNodeLike, fn)
    }
  }
}

export function remarkRewriteFileUriLinks() {
  return (tree: MdastNodeLike) => {
    // Definitions are shared between linkReference and imageReference. Skip
    // any definition whose identifier is consumed by an imageReference so
    // image blocking still wins for those cases.
    const imageRefIds = new Set<string>()
    walk(tree, (node) => {
      if (
        node.type === "imageReference" &&
        typeof node.identifier === "string"
      ) {
        imageRefIds.add(node.identifier.toLowerCase())
      }
    })

    walk(tree, (node) => {
      if (typeof node.url !== "string") return
      if (node.type === "link") {
        const rewritten = fileUriToLocalPath(node.url)
        if (rewritten != null) node.url = rewritten
        return
      }
      if (node.type === "definition") {
        const id =
          typeof node.identifier === "string"
            ? node.identifier.toLowerCase()
            : ""
        if (imageRefIds.has(id)) return
        const rewritten = fileUriToLocalPath(node.url)
        if (rewritten != null) node.url = rewritten
      }
    })
  }
}
